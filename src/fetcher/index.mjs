import { isAllowedSourceUrl } from '../contracts/source.mjs';

export class Fetcher {
  constructor({ transport, rawStore, persistence, clock, policy, allowedHosts }) {
    this.transport = transport;
    this.rawStore = rawStore;
    this.persistence = persistence;
    this.clock = clock;
    this.policy = policy;
    this.allowedHosts = allowedHosts;
  }

  async fetch(job, lease) {
    if (!isAllowedSourceUrl(job.sourceUrl, this.allowedHosts)) {
      throw new Error(`source URL rejected before transport: ${job.sourceUrl.absoluteUrl}. Expected an HTTPS URL on an allowed host.`);
    }
    const request = this.persistence.acquireRequest(job.key, lease, job.sourceUrl.host);
    if (!request) return { kind: 'retry_wait', reason: 'host request already owned' };
    try {
      const response = await this.transport.request({ method: 'GET', url: job.sourceUrl.absoluteUrl, headers: { 'user-agent': this.policy.userAgent } });
      if (response.redirectUrl) {
        if (!isAllowedSourceUrl(response.redirectUrl, this.allowedHosts)) return { kind: 'operator_stop', reason: 'redirect target is not allowlisted' };
      }
      if (response.status === 304) {
        const prior = this.persistence.sourceFetches.findLast((fetch) => fetch.jobKey === job.key && fetch.checksum);
        if (!prior || !this.rawStore.has(prior.checksum)) return { kind: 'operator_stop', reason: '304 has no durable prior raw snapshot' };
        const sourceFetchId = this.persistence.recordFetch({ jobKey: job.key, status: 304, checksum: prior.checksum, objectPath: prior.objectPath, validator: response.headers ?? {}, reusedBody: true }, lease);
        return { kind: 'not_modified', sourceFetchId, checksum: prior.checksum };
      }
      if (response.status === 429) return { kind: 'retry_wait', reason: 'rate limited', retryAfter: response.headers?.['retry-after'] };
      if (response.status === 403 || response.challenge) return { kind: 'operator_stop', reason: 'operator review required for challenge response' };
      if (response.status >= 500) return { kind: 'retry_wait', reason: `upstream ${response.status}` };
      if (response.status < 200 || response.status >= 300) return { kind: 'permanently_failed', reason: `upstream ${response.status}` };
      const raw = this.rawStore.put(response.body);
      const sourceFetchId = this.persistence.recordFetch({ jobKey: job.key, status: response.status, checksum: raw.checksum, objectPath: raw.objectPath, validator: response.headers ?? {} }, lease);
      return { kind: 'fetched', sourceFetchId, checksum: raw.checksum, body: Buffer.from(response.body) };
    } finally {
      this.persistence.releaseRequest(job.key, lease);
    }
  }
}

export class FixtureTransport {
  constructor(fixtures = new Map()) { this.fixtures = fixtures; this.calls = []; }
  async request({ method, url }) {
    if (method !== 'GET') throw new Error(`transport rejected method ${method}. Expected GET only. Example: method: GET`);
    this.calls.push(url);
    const fixture = this.fixtures.get(url);
    if (!fixture) return { status: 404, headers: {}, body: Buffer.from('') };
    return { status: 200, headers: { etag: fixture.etag ?? `fixture-${this.calls.length}` }, body: Buffer.from(fixture.body) };
  }
}
