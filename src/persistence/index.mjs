import { createHash } from 'node:crypto';
import { assertTransition, sameLease } from '../contracts/jobs.mjs';

export class MemoryRawStore {
  #objects = new Map();

  put(bytes) {
    const body = Buffer.from(bytes);
    const checksum = createHash('sha256').update(body).digest('hex');
    const existing = this.#objects.get(checksum);
    if (existing && !existing.body.equals(body)) throw new Error(`raw checksum collision: ${checksum}`);
    if (!existing) this.#objects.set(checksum, { checksum, body, objectPath: `memory://${checksum}` });
    return Object.freeze({ checksum, objectPath: `memory://${checksum}`, size: body.length });
  }

  get(checksum) {
    const object = this.#objects.get(checksum);
    return object ? Object.freeze({ ...object, body: Buffer.from(object.body) }) : null;
  }

  has(checksum) { return this.#objects.has(checksum); }
  entries() { return [...this.#objects.values()].map(({ checksum, objectPath, size, body }) => ({ checksum, objectPath, size: size ?? body.length })); }
}

export class InMemoryPersistence {
  constructor(clock = () => new Date()) {
    this.clock = clock;
    this.jobs = new Map();
    this.sourceFetches = [];
    this.parseRuns = [];
    this.pages = new Map();
    this.observations = [];
    this.unavailableCoverage = [];
    this.operatorDispositions = [];
    this.inFlight = new Map();
  }

  addJob(job) {
    const existing = this.jobs.get(job.key);
    if (existing) return existing;
    const stored = { ...job, state: 'pending', attempts: 0, createdAt: this.clock().toISOString() };
    this.jobs.set(job.key, stored);
    return stored;
  }

  listJobs() { return [...this.jobs.values()].map((job) => ({ ...job })); }
  getJob(key) { return this.jobs.get(key); }

  claimNextJob(now, workerId) {
    const current = [...this.jobs.values()].find((job) => (job.state === 'pending' || (job.state === 'retry_wait' && new Date(job.nextAllowedAt) <= now)) && !job.claim);
    if (!current) return null;
    const generation = (current.generation ?? 0) + 1;
    const lease = { workerId, generation, value: `${workerId}:${generation}` };
    current.state = 'fetching';
    current.attempts += 1;
    current.claim = { owner: workerId, expiresAt: new Date(now.getTime() + 30_000).toISOString(), lease };
    return { ...current, lease };
  }

  renewClaim(key, lease, now) {
    const job = this.#requireLease(key, lease);
    job.claim.expiresAt = new Date(now.getTime() + 30_000).toISOString();
  }

  recoverExpiredClaims(now) {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.claim && new Date(job.claim.expiresAt) <= now && !this.inFlight.has(job.key)) {
        job.claim = null;
        if (job.state === 'fetching') job.state = 'retry_wait';
        job.nextAllowedAt = now.toISOString();
        recovered += 1;
      }
    }
    return recovered;
  }

  recordFetch(metadata, lease) {
    this.#requireLease(metadata.jobKey, lease);
    const id = `fetch-${this.sourceFetches.length + 1}`;
    const record = Object.freeze({ id, ...metadata, recordedAt: this.clock().toISOString() });
    this.sourceFetches.push(record);
    return id;
  }

  recordParse(run, lease) {
    this.#requireLease(run.jobKey, lease);
    const id = `parse-${this.parseRuns.length + 1}`;
    const record = Object.freeze({ id, ...run, recordedAt: this.clock().toISOString() });
    this.parseRuns.push(record);
    return id;
  }

  commitPage(page, provenance, lease) {
    this.#requireLease(page.jobKey, lease);
    const key = page.identity ?? page.jobKey;
    this.pages.set(key, Object.freeze({ ...page, provenance }));
    for (const observation of page.observations ?? []) this.observations.push(Object.freeze({ ...observation, provenance }));
    for (const unavailable of page.unavailableCoverage ?? []) this.unavailableCoverage.push(Object.freeze({ ...unavailable, provenance }));
    for (const child of page.childJobs ?? []) this.addJob(child);
    return key;
  }

  transitionJob(key, nextState, lease, details = {}) {
    const job = this.#requireLease(key, lease);
    assertTransition(job.state, nextState);
    job.state = nextState;
    Object.assign(job, details);
    if (['parsed', 'parse_failed', 'permanently_failed'].includes(nextState)) job.claim = null;
  }

  recordOperatorDisposition(key, disposition, lease) {
    const job = this.#requireLease(key, lease);
    if (job.state !== 'operator_stop') throw new Error(`operator disposition requires operator_stop. Current state: ${job.state}`);
    this.operatorDispositions.push(Object.freeze({ jobKey: key, ...disposition }));
    if (disposition.kind === 'release_retry') this.transitionJob(key, 'retry_wait', lease, { nextAllowedAt: this.clock().toISOString() });
    if (disposition.kind === 'release_permanent') this.transitionJob(key, 'permanently_failed', lease, { failureReason: disposition.reason });
  }

  acquireRequest(key, lease, host) {
    this.#requireLease(key, lease);
    if ([...this.inFlight.values()].some((request) => request.host === host)) return null;
    const request = Object.freeze({ id: `request-${this.inFlight.size + 1}`, jobKey: key, host, lease });
    this.inFlight.set(key, request);
    return request;
  }

  releaseRequest(key, lease) {
    const request = this.inFlight.get(key);
    if (!request || !sameLease(request.lease, lease)) throw new Error('request ownership mismatch. Expected the current lease token before release. Example: workerId: worker-1');
    this.inFlight.delete(key);
  }

  queryModels() {
    return {
      schools: [...this.pages.values()].filter((page) => page.kind === 'school').map(({ data, provenance }) => ({ ...data, provenance })),
      seasons: [...this.pages.values()].filter((page) => page.kind === 'season').map(({ data, provenance }) => ({ ...data, provenance })),
      games: [...this.pages.values()].filter((page) => page.kind === 'game').map(({ data, provenance }) => ({ ...data, provenance })),
      health: { jobs: this.listJobs(), sourceFetches: this.sourceFetches.length, parseRuns: this.parseRuns.length, conflicts: this.observations.filter((item) => item.conflict).length },
    };
  }

  #requireLease(key, lease) {
    const job = this.jobs.get(key);
    if (!job || !job.claim || !sameLease(job.claim.lease, lease) || new Date(job.claim.expiresAt) <= this.clock()) {
      throw new Error(`stale or missing lease for job ${key}. Expected the current unexpired lease token.`);
    }
    return job;
  }
}
