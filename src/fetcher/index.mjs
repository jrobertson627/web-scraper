import { createHash } from 'node:crypto';
import { createSourceUrl, isAllowedSourceUrl } from '../contracts/source.mjs';

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
    this.lastRequestStartedAt = new Map();
    this.requestStarts = new Map();
  }

  async fetch(job, lease) {
    if (!isAllowedSourceUrl(job.sourceUrl, this.allowedHosts)) {
      throw new Error(`source URL rejected before transport: ${job.sourceUrl?.absoluteUrl}. Expected an HTTPS URL on an allowed host.`);
    }
    const request = this.persistence.acquireRequest(job.key, lease, job.sourceUrl.host);
    if (!request) return { kind: 'retry_wait', reason: 'host request already owned', nextAllowedAt: this.#nextTime(1000) };
    try {
      await this.#waitForPolicy(job.sourceUrl.host);
      const prior = this.persistence.lastSuccessfulFetch(job.key);
      const headers = { 'user-agent': this.policy.userAgent };
      if (prior?.etag) headers['if-none-match'] = prior.etag;
      if (prior?.lastModified) headers['if-modified-since'] = prior.lastModified;
      const startedAt = this.clock();
      this.#recordRequestStart(job.sourceUrl.host, startedAt);
      let response;
      try {
        response = await this.transport.request({ method: 'GET', url: job.sourceUrl.absoluteUrl, headers });
      } catch (error) {
        return this.#retry(job, `transport error: ${error.message}`);
      }
      if (response.redirectUrl) {
        try {
          const redirect = createSourceUrl(job.sourceUrl.providerId, response.redirectUrl, job.sourceUrl.absoluteUrl);
          if (!isAllowedSourceUrl(redirect, this.allowedHosts)) return { kind: 'operator_stop', reason: 'redirect target is not allowlisted' };
        } catch (error) {
          return { kind: 'operator_stop', reason: `invalid redirect target: ${error.message}` };
        }
      }
      if (response.status === 304) {
        if (!prior || !this.rawStore.has(prior.checksum)) return { kind: 'operator_stop', reason: '304 has no durable prior raw snapshot' };
        const sourceFetchId = this.persistence.recordFetch({
          jobKey: job.key,
          status: 304,
          checksum: prior.checksum,
          objectPath: prior.objectPath,
          etag: header(response.headers, 'etag') ?? prior.etag,
          lastModified: header(response.headers, 'last-modified') ?? prior.lastModified,
          fetchedAt: startedAt.toISOString(),
          reusedBody: true,
        }, lease);
        return { kind: 'not_modified', sourceFetchId, checksum: prior.checksum };
      }
      if (response.status === 429) {
        const retryAfter = header(response.headers, 'retry-after');
        const retryAt = retryAfterDate(retryAfter, this.clock());
        if (!retryAt) return { kind: 'operator_stop', reason: 'rate limited without Retry-After; operator review required' };
        return { kind: 'retry_wait', reason: 'rate limited', nextAllowedAt: retryAt.toISOString() };
      }
      if (response.status === 403 || response.challenge) return { kind: 'operator_stop', reason: 'operator review required for challenge response' };
      if (response.status >= 500) return this.#retry(job, `upstream ${response.status}`);
      if (response.status < 200 || response.status >= 300) return { kind: 'permanently_failed', reason: `upstream ${response.status}` };
      const body = Buffer.from(response.body ?? '');
      const raw = this.rawStore.put(body);
      const sourceFetchId = this.persistence.recordFetch({
        jobKey: job.key,
        status: response.status,
        checksum: raw.checksum,
        objectPath: raw.objectPath,
        etag: header(response.headers, 'etag'),
        lastModified: header(response.headers, 'last-modified'),
        fetchedAt: startedAt.toISOString(),
        reusedBody: false,
      }, lease);
      return { kind: 'fetched', sourceFetchId, checksum: raw.checksum };
    } finally {
      this.persistence.releaseRequest(job.key, lease);
    }
  }

  async #waitForPolicy(host) {
    for (;;) {
      const now = this.clock();
      const last = this.lastRequestStartedAt.get(host);
      const intervalDelay = last ? Math.max(0, this.policy.minIntervalMs - (now.getTime() - last.getTime())) : 0;
      const starts = (this.requestStarts.get(host) ?? []).filter((at) => now.getTime() - at.getTime() < 60_000);
      this.requestStarts.set(host, starts);
      const rateDelay = starts.length >= this.policy.maxRequestsPerMinute
        ? Math.max(0, 60_000 - (now.getTime() - starts[0].getTime()))
        : 0;
      const delay = Math.max(intervalDelay, rateDelay);
      if (delay === 0) return;
      await this.sleep(delay);
    }
  }

  #recordRequestStart(host, at) {
    this.lastRequestStartedAt.set(host, at);
    const starts = (this.requestStarts.get(host) ?? []).filter((item) => at.getTime() - item.getTime() < 60_000);
    starts.push(at);
    this.requestStarts.set(host, starts);
  }

  #retry(job, reason) {
    const maxAttempts = this.policy.maxAttempts ?? 3;
    if (job.attempts >= maxAttempts) return { kind: 'permanently_failed', reason: `${reason}; retry limit reached` };
    const base = this.policy.retryBaseMs ?? 1000;
    const delay = Math.min(base * (2 ** Math.max(0, job.attempts - 1)), this.policy.retryMaxMs ?? 60_000);
    return { kind: 'retry_wait', reason, nextAllowedAt: this.#nextTime(delay) };
  }

  #nextTime(delay) { return new Date(this.clock().getTime() + delay).toISOString(); }
}

export class FixtureTransport {
  constructor(fixtures = new Map()) { this.fixtures = fixtures; this.calls = []; this.requests = []; }

  async request({ method, url, headers = {} }) {
    if (method !== 'GET') throw new Error(`transport rejected method ${method}. Expected GET only. Example: method: GET`);
    this.calls.push(url);
    this.requests.push({ method, url, headers: { ...headers } });
    const fixture = this.fixtures.get(url);
    if (!fixture) return { status: 404, headers: {}, body: Buffer.from('') };
    const etag = fixture.etag ?? `fixture-${createHash('sha256').update(fixture.body).digest('hex')}`;
    if (headers['if-none-match'] === etag) return { status: 304, headers: { etag }, body: Buffer.alloc(0) };
    return { status: 200, headers: { etag, ...(fixture.lastModified ? { 'last-modified': fixture.lastModified } : {}) }, body: Buffer.from(fixture.body) };
  }
}
