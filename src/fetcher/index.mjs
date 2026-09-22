import { createHash } from 'node:crypto';
import { createSourceUrl, isAllowedSourceUrl } from '../contracts/source.mjs';
import { createFetchResult } from '../contracts/boundaries.mjs';

function header(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function retryAfterDate(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(now.getTime() + Math.max(0, seconds) * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class Fetcher {
  constructor({ transport, rawStore, persistence, clock, policy, allowedHosts, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.transport = transport;
    this.rawStore = rawStore;
    this.persistence = persistence;
    this.clock = clock;
    this.policy = policy;
    this.allowedHosts = allowedHosts;
    this.sleep = sleep;
  }

  async fetch(job, lease) {
    if (!isAllowedSourceUrl(job.sourceUrl, this.allowedHosts)) {
      throw new Error(`source URL rejected before transport: ${job.sourceUrl?.absoluteUrl}. Expected an HTTPS URL on an allowed host.`);
    }
    const request = this.persistence.acquireRequest(job.key, lease, job.sourceUrl.host);
    if (!request) return createFetchResult({ kind: 'retry_wait', reason: 'host request already owned', nextAllowedAt: this.#nextTime(1000) });
    try {
      const prior = this.persistence.lastSuccessfulFetch(job.key);
      let headers = { 'user-agent': this.policy.userAgent };
      if (prior?.etag) headers['if-none-match'] = prior.etag;
      if (prior?.lastModified) headers['if-modified-since'] = prior.lastModified;
      let sourceUrl = job.sourceUrl;
      let response;
      let startedAt;
      for (let redirectCount = 0; ; redirectCount += 1) {
        if (!isAllowedSourceUrl(sourceUrl, this.allowedHosts)) return createFetchResult({ kind: 'operator_stop', reason: 'redirect target is not allowlisted' });
        await this.#waitForPolicy(job, lease, sourceUrl.host);
        startedAt = this.clock();
        this.#recordRequestStart(sourceUrl.host, startedAt);
        try {
          response = await this.transport.request({ method: 'GET', url: sourceUrl.absoluteUrl, headers, redirect: 'manual' });
        } catch (error) {
          return this.#retry(job, `transport error: ${error.message}`);
        }
        if (!response.redirectUrl) break;
        if (redirectCount >= 4) return createFetchResult({ kind: 'operator_stop', reason: 'redirect limit exceeded' });
        try {
          const redirect = createSourceUrl(job.sourceUrl.providerId, response.redirectUrl, sourceUrl.absoluteUrl);
          if (!isAllowedSourceUrl(redirect, this.allowedHosts)) return createFetchResult({ kind: 'operator_stop', reason: 'redirect target is not allowlisted' });
          sourceUrl = redirect;
          headers = { 'user-agent': this.policy.userAgent };
        } catch (error) {
          return createFetchResult({ kind: 'operator_stop', reason: `invalid redirect target: ${error.message}` });
        }
      }
      if (response.status === 304) {
        const priorVerification = prior ? this.rawStore.verify(prior.checksum, prior.objectPath) : { ok: false };
        if (!prior || !priorVerification.ok) return createFetchResult({ kind: 'operator_stop', reason: '304 has no durable verified prior raw snapshot' });
        const sourceFetchId = this.persistence.recordFetch({
          jobKey: job.key,
          status: 304,
          checksum: prior.checksum,
          objectPath: prior.objectPath,
          etag: header(response.headers, 'etag') ?? prior.etag,
          lastModified: header(response.headers, 'last-modified') ?? prior.lastModified,
          fetchedAt: startedAt.toISOString(),
          reusedBody: true,
        }, lease, this.rawStore);
        return createFetchResult({ kind: 'not_modified', sourceFetchId, checksum: prior.checksum });
      }
      if (response.status === 429) {
        const retryAfter = header(response.headers, 'retry-after');
        const retryAt = retryAfterDate(retryAfter, this.clock());
        if (!retryAt) return createFetchResult({ kind: 'operator_stop', reason: 'rate limited without Retry-After; operator review required' });
        return createFetchResult({ kind: 'retry_wait', reason: 'rate limited', nextAllowedAt: retryAt.toISOString() });
      }
      if (response.status === 403 || response.challenge) return createFetchResult({ kind: 'operator_stop', reason: 'operator review required for challenge response' });
      if (response.status >= 500) return this.#retry(job, `upstream ${response.status}`);
      if (response.status < 200 || response.status >= 300) return createFetchResult({ kind: 'permanently_failed', reason: `upstream ${response.status}` });
      const body = Buffer.from(response.body ?? '');
      const raw = this.rawStore.put(body);
      const verification = this.rawStore.verify(raw.checksum, raw.objectPath);
      if (!verification.ok) return createFetchResult({ kind: 'operator_stop', reason: `raw finalization failed verification: ${verification.reason}` });
      const sourceFetchId = this.persistence.recordFetch({
        jobKey: job.key,
        status: response.status,
        checksum: raw.checksum,
        objectPath: raw.objectPath,
        etag: header(response.headers, 'etag'),
        lastModified: header(response.headers, 'last-modified'),
        fetchedAt: startedAt.toISOString(),
        reusedBody: false,
      }, lease, this.rawStore);
      return createFetchResult({ kind: 'fetched', sourceFetchId, checksum: raw.checksum });
    } finally {
      this.persistence.releaseRequest(job.key, lease);
    }
  }

  async #waitForPolicy(job, lease, host = job.sourceUrl.host) {
    for (;;) {
      const now = this.clock();
      const schedule = this.#getSchedule(host, now);
      const intervalDelay = schedule.lastStartedAt ? Math.max(0, this.policy.minIntervalMs - (now.getTime() - schedule.lastStartedAt.getTime())) : 0;
      const starts = schedule.starts.filter((at) => now.getTime() - at.getTime() < 60_000);
      const rateDelay = starts.length >= this.policy.maxRequestsPerMinute
        ? Math.max(0, 60_000 - (now.getTime() - starts[0].getTime()))
        : 0;
      const delay = Math.max(intervalDelay, rateDelay);
      if (delay === 0) return;
      this.persistence.renewClaim(job.key, lease, now);
      const before = this.clock().getTime();
      await this.sleep(Math.min(delay, 10_000));
      const after = this.clock().getTime();
      if (after <= before) throw new Error('throttle sleep did not advance the injected clock');
      this.persistence.renewClaim(job.key, lease, this.clock());
    }
  }

  #getSchedule(host, now) {
    return this.persistence.getRequestSchedule(host, now);
  }

  #recordRequestStart(host, at) {
    this.persistence.recordRequestStart(host, at);
  }

  #retry(job, reason) {
    const maxAttempts = this.policy.maxAttempts ?? 3;
    if (job.attempts >= maxAttempts) return createFetchResult({ kind: 'permanently_failed', reason: `${reason}; retry limit reached` });
    const base = this.policy.retryBaseMs ?? 1000;
    const delay = Math.min(base * (2 ** Math.max(0, job.attempts - 1)), this.policy.retryMaxMs ?? 60_000);
    return createFetchResult({ kind: 'retry_wait', reason, nextAllowedAt: this.#nextTime(delay) });
  }

  #nextTime(delay) { return new Date(this.clock().getTime() + delay).toISOString(); }
}

export class FixtureTransport {
  constructor(fixtures = new Map()) { this.fixtures = fixtures; this.calls = []; this.requests = []; }

  async request({ method, url, headers = {}, redirect = 'manual' }) {
    if (method !== 'GET') throw new Error(`transport rejected method ${method}. Expected GET only. Example: method: GET`);
    if (redirect !== 'manual') throw new Error('transport requires manual redirect handling so targets can be allowlisted before request.');
    this.calls.push(url);
    this.requests.push({ method, url, headers: { ...headers } });
    const fixture = this.fixtures.get(url);
    if (!fixture) return { status: 404, headers: {}, body: Buffer.from('') };
    if (fixture.redirectUrl) return { status: fixture.status ?? 302, headers: fixture.headers ?? {}, redirectUrl: fixture.redirectUrl, body: Buffer.alloc(0) };
    const etag = fixture.etag ?? `fixture-${createHash('sha256').update(fixture.body).digest('hex')}`;
    if (headers['if-none-match'] === etag) return { status: 304, headers: { etag }, body: Buffer.alloc(0) };
    return { status: 200, headers: { etag, ...(fixture.lastModified ? { 'last-modified': fixture.lastModified } : {}) }, body: Buffer.from(fixture.body) };
  }
}
