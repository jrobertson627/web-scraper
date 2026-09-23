import { createHash } from 'node:crypto';
import { createSourceUrl, isAllowedSourceUrl } from '../contracts/source.mjs';
import { createFetchResult } from '../contracts/boundaries.mjs';
import { validateRequestPolicy } from '../contracts/request-policy.mjs';
import { HttpTransport } from './http-transport.mjs';

function header(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function retryAfterDate(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const date = Number.isSafeInteger(seconds) ? new Date(now.getTime() + seconds * 1000) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let match;
  let dayName;
  let day;
  let month;
  let year;
  let hour;
  let minute;
  let second;
  if ((match = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(trimmed))) {
    [, dayName, day, month, year, hour, minute, second] = match;
  } else if ((match = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(trimmed))) {
    [, dayName, day, month, year, hour, minute, second] = match;
    year = 2000 + Number(year);
    if (year > now.getUTCFullYear() + 50) year -= 100;
  } else if ((match = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(trimmed))) {
    [, dayName, month, day, hour, minute, second, year] = match;
  } else return null;
  const parts = [Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)];
  const date = new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1]
      || date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3]
      || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]
      || !dayName.startsWith(weekdays[date.getUTCDay()])) return null;
  return date;
}

function freshAgeLimit(policyAge, cacheControl) {
  if (/(?:^|,)\s*no-(?:store|cache)\b/i.test(cacheControl ?? '')) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*(?:"(\d+)"|(\d+))(?:\s*,|\s*$)/i.exec(cacheControl ?? '');
  if (!match) return /(?:^|,)\s*max-age\b/i.test(cacheControl ?? '') ? 0 : policyAge;
  const seconds = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(seconds) ? Math.min(policyAge, seconds * 1000) : 0;
}

function forbidsStoredReuse(cacheControl) {
  return /(?:^|,)\s*no-store\b/i.test(cacheControl ?? '');
}

export class Fetcher {
  constructor({ transport = new HttpTransport(), rawStore, persistence, clock, policy, allowedHosts, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.transport = transport;
    this.rawStore = rawStore;
    this.persistence = persistence;
    this.clock = clock;
    this.policy = validateRequestPolicy(policy);
    this.allowedHosts = Object.freeze([...(allowedHosts ?? [])]);
    this.sleep = sleep;
  }

  async fetch(job, lease) {
    if (!isAllowedSourceUrl(job.sourceUrl, this.allowedHosts)) {
      throw new Error(`source URL rejected before transport: ${job.sourceUrl?.absoluteUrl}. Expected an HTTPS URL on an allowed host.`);
    }
    const prior = await this.persistence.lastSuccessfulFetch(job.key);
    if (prior && this.policy.cacheMaxAgeMs > 0) {
      const ageMs = this.clock().getTime() - new Date(prior.fetchedAt).getTime();
      if (ageMs >= 0 && ageMs < freshAgeLimit(this.policy.cacheMaxAgeMs, prior.cacheControl)) {
        const verification = this.rawStore.verify(prior.checksum, prior.objectPath);
        if (!verification.ok) return createFetchResult({ kind: 'operator_stop', reason: 'cached raw snapshot failed verification' });
        const sourceFetchId = await this.persistence.recordFetch({
          jobKey: job.key, status: 200, checksum: prior.checksum, objectPath: prior.objectPath,
          etag: prior.etag, lastModified: prior.lastModified, cacheControl: prior.cacheControl,
          reusedBody: true, cacheHit: true,
        }, lease, this.rawStore);
        return createFetchResult({ kind: 'not_modified', sourceFetchId, checksum: prior.checksum });
      }
    }
    const requestHost = new URL(job.sourceUrl.absoluteUrl).host;
    let ownedHost = requestHost;
    let ownsRequest = Boolean(await this.persistence.acquireRequest(job.key, lease, ownedHost));
    if (!ownsRequest) return createFetchResult({ kind: 'retry_wait', reason: 'host request already owned', nextAllowedAt: this.#nextTime(1000) });
    try {
      let headers = { 'user-agent': this.policy.userAgent };
      if (prior && !forbidsStoredReuse(prior.cacheControl)) {
        if (prior.etag) headers['if-none-match'] = prior.etag;
        if (prior.lastModified) headers['if-modified-since'] = prior.lastModified;
      }
      let sourceUrl = job.sourceUrl;
      let response;
      let startedAt;
      for (let redirectCount = 0; ; redirectCount += 1) {
        if (!isAllowedSourceUrl(sourceUrl, this.allowedHosts)) return createFetchResult({ kind: 'operator_stop', reason: 'redirect target is not allowlisted' });
        const host = new URL(sourceUrl.absoluteUrl).host;
        if (host !== ownedHost) {
          await this.persistence.releaseRequest(job.key, lease);
          ownsRequest = false;
          ownedHost = host;
          ownsRequest = Boolean(await this.persistence.acquireRequest(job.key, lease, ownedHost));
          if (!ownsRequest) return createFetchResult({ kind: 'retry_wait', reason: 'redirect host request already owned', nextAllowedAt: this.#nextTime(1000) });
        }
        await this.#waitForPolicy(job, lease, host);
        startedAt = this.clock();
        await this.#recordRequestStart(host, startedAt);
        try {
          response = await this.#requestWithRenewal(job, lease, { method: 'GET', url: sourceUrl.absoluteUrl, headers, redirect: 'manual', timeoutMs: this.policy.requestTimeoutMs, maxResponseBytes: this.policy.maxResponseBytes });
        } catch (error) {
          if (error?.code === 'lease_renewal_failed') throw error;
          const code = error?.code ?? 'transient_network';
          if (['dns_rejected', 'tls_rejected', 'response_too_large', 'unsupported_encoding', 'invalid_request', 'malformed_response'].includes(code)) {
            return createFetchResult({ kind: 'operator_stop', code, reason: `transport stopped: ${error.message}` });
          }
          return this.#retry(job, `transport error: ${error.message}`, code);
        }
        if (!response.redirectUrl) break;
        if (redirectCount >= this.policy.maxRedirects) return createFetchResult({ kind: 'operator_stop', reason: 'redirect limit exceeded' });
        try {
          const redirect = createSourceUrl(job.sourceUrl.providerId, response.redirectUrl, sourceUrl.absoluteUrl);
          if (!isAllowedSourceUrl(redirect, this.allowedHosts)) return createFetchResult({ kind: 'operator_stop', reason: 'redirect target is not allowlisted' });
          sourceUrl = redirect;
          headers = { 'user-agent': this.policy.userAgent };
        } catch (error) {
          return createFetchResult({ kind: 'operator_stop', reason: `invalid redirect target: ${error.message}` });
        }
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        return createFetchResult({ kind: 'operator_stop', code: 'invalid_redirect', reason: 'redirect response has no usable Location' });
      }
      if (response.status === 304) {
        if (!headers['if-none-match'] && !headers['if-modified-since']) {
          return createFetchResult({ kind: 'operator_stop', code: 'unexpected_304', reason: '304 returned without a conditional request' });
        }
        const priorVerification = prior && !forbidsStoredReuse(prior.cacheControl) ? this.rawStore.verify(prior.checksum, prior.objectPath) : { ok: false };
        if (!prior || !priorVerification.ok) return createFetchResult({ kind: 'operator_stop', reason: '304 has no durable verified prior raw snapshot' });
        const sourceFetchId = await this.persistence.recordFetch({
          jobKey: job.key,
          status: 304,
          checksum: prior.checksum,
          objectPath: prior.objectPath,
          etag: header(response.headers, 'etag') ?? prior.etag,
          lastModified: header(response.headers, 'last-modified') ?? prior.lastModified,
          cacheControl: header(response.headers, 'cache-control') ?? prior.cacheControl,
          fetchedAt: startedAt.toISOString(),
          reusedBody: true,
        }, lease, this.rawStore);
        return createFetchResult({ kind: 'not_modified', sourceFetchId, checksum: prior.checksum });
      }
      if (response.status === 429) {
        const retryAfter = header(response.headers, 'retry-after');
        const retryAt = retryAfterDate(retryAfter, this.clock());
        if (!retryAt) return createFetchResult({ kind: 'operator_stop', code: 'invalid_retry_after', reason: 'rate limited without valid Retry-After; operator review required' });
        if (retryAt.getTime() - this.clock().getTime() > this.policy.maxRetryAfterMs) {
          return createFetchResult({ kind: 'operator_stop', code: 'retry_after_too_long', reason: 'Retry-After exceeds the configured maximum; operator review required' });
        }
        const earliest = this.#nextTime(this.policy.minIntervalMs);
        return createFetchResult({ kind: 'retry_wait', reason: 'rate limited', nextAllowedAt: new Date(Math.max(retryAt.getTime(), Date.parse(earliest))).toISOString() });
      }
      if (response.status === 403 || response.challenge) return createFetchResult({ kind: 'operator_stop', code: 'challenge', reason: 'operator review required for challenge response' });
      if (response.status >= 500) return this.#retry(job, `upstream ${response.status}`);
      if (response.status < 200 || response.status >= 300) return createFetchResult({ kind: 'permanently_failed', reason: `upstream ${response.status}` });
      const body = Buffer.from(response.body ?? '');
      if (body.length > this.policy.maxResponseBytes) return createFetchResult({ kind: 'operator_stop', code: 'response_too_large', reason: 'response body exceeds the configured byte limit' });
      const raw = this.rawStore.put(body);
      const verification = this.rawStore.verify(raw.checksum, raw.objectPath);
      if (!verification.ok) return createFetchResult({ kind: 'operator_stop', reason: `raw finalization failed verification: ${verification.reason}` });
      const sourceFetchId = await this.persistence.recordFetch({
        jobKey: job.key,
        status: response.status,
        checksum: raw.checksum,
        objectPath: raw.objectPath,
        etag: header(response.headers, 'etag'),
        lastModified: header(response.headers, 'last-modified'),
        cacheControl: header(response.headers, 'cache-control'),
        fetchedAt: startedAt.toISOString(),
        reusedBody: false,
      }, lease, this.rawStore);
      return createFetchResult({ kind: 'fetched', sourceFetchId, checksum: raw.checksum });
    } finally {
      if (ownsRequest) await this.persistence.releaseRequest(job.key, lease);
    }
  }

  async #waitForPolicy(job, lease, host = job.sourceUrl.host) {
    // Cap each sleep chunk to a fraction of claimTimeoutMs (not a fixed 10s):
    // at claimTimeoutMs's configured minimum, a full 10s chunk left zero
    // margin between renewal and expiry, so a claim could read as expired
    // under real (non-mocked) clock jitter.
    const maxChunkMs = Math.max(50, Math.min(10_000, Math.floor((this.persistence.claimTimeoutMs ?? 30_000) / 3)));
    for (;;) {
      const now = this.clock();
      const schedule = await this.#getSchedule(host, now);
      const intervalDelay = schedule.lastStartedAt ? Math.max(0, this.policy.minIntervalMs - (now.getTime() - schedule.lastStartedAt.getTime())) : 0;
      const starts = schedule.starts.filter((at) => now.getTime() - at.getTime() < 60_000);
      const rateDelay = starts.length >= this.policy.maxRequestsPerMinute
        ? Math.max(0, 60_000 - (now.getTime() - starts[0].getTime()))
        : 0;
      const delay = Math.max(intervalDelay, rateDelay);
      if (delay === 0) return;
      await this.persistence.renewClaim(job.key, lease, now);
      const before = this.clock().getTime();
      await this.sleep(Math.min(delay, maxChunkMs));
      const after = this.clock().getTime();
      if (after <= before) throw new Error('throttle sleep did not advance the injected clock');
      await this.persistence.renewClaim(job.key, lease, this.clock());
    }
  }

  async #requestWithRenewal(job, lease, request) {
    await this.persistence.renewClaim(job.key, lease, this.clock());
    const intervalMs = Math.max(50, Math.min(5_000, Math.floor((this.persistence.claimTimeoutMs ?? 15_000) / 3)));
    let renewalFailure;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(() => this.persistence.renewClaim(job.key, lease, this.clock())).catch((error) => {
        renewalFailure = error;
        clearInterval(timer);
      });
    }, intervalMs);
    try {
      const response = await this.transport.request(request);
      clearInterval(timer);
      await renewal;
      if (renewalFailure) throw Object.assign(new Error('claim renewal failed during request', { cause: renewalFailure }), { code: 'lease_renewal_failed' });
      return response;
    } catch (error) {
      clearInterval(timer);
      await renewal;
      if (renewalFailure && error?.code !== 'lease_renewal_failed') {
        throw Object.assign(new Error('claim renewal failed during request', { cause: renewalFailure }), { code: 'lease_renewal_failed' });
      }
      throw error;
    } finally { clearInterval(timer); }
  }

  async #getSchedule(host, now) {
    return this.persistence.getRequestSchedule(host, now);
  }

  async #recordRequestStart(host, at) {
    return this.persistence.recordRequestStart(host, at);
  }

  #retry(job, reason, code) {
    if (job.attempts >= this.policy.maxAttempts) return createFetchResult({ kind: 'permanently_failed', code, reason: `${reason}; retry limit reached` });
    const delay = Math.min(this.policy.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)), this.policy.retryMaxMs);
    return createFetchResult({ kind: 'retry_wait', code, reason, nextAllowedAt: this.#nextTime(delay) });
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
