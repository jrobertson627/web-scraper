import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertTransition, createOperatorDisposition, sameLease } from '../contracts/jobs.mjs';
import { createJob, createQueryModels, createReconciliationIssue } from '../contracts/boundaries.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function cloneClaim(claim) {
  return claim ? { ...claim, lease: claim.lease ? { ...claim.lease } : claim.lease } : null;
}

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

  has(checksum) { return this.verify(checksum).ok; }
  entries() { return [...this.#objects.values()].map(({ checksum, objectPath, body }) => ({ checksum, objectPath, size: body.length })); }

  verify(checksum, expectedObjectPath) {
    const object = this.get(checksum);
    if (!object) return Object.freeze({ ok: false, reason: 'missing raw object', checksum });
    const actualChecksum = createHash('sha256').update(object.body).digest('hex');
    if (actualChecksum !== checksum) return Object.freeze({ ok: false, reason: 'raw object checksum mismatch', checksum, actualChecksum, objectPath: object.objectPath });
    if (expectedObjectPath && object.objectPath !== expectedObjectPath) {
      return Object.freeze({ ok: false, reason: 'raw object path mismatch', checksum, objectPath: object.objectPath, expectedObjectPath });
    }
    return Object.freeze({ ok: true, checksum, objectPath: object.objectPath, size: object.body.length });
  }
}

export class FileRawStore {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  put(bytes) {
    const body = Buffer.from(bytes);
    const checksum = createHash('sha256').update(body).digest('hex');
    const path = this.#path(checksum);
    mkdirSync(dirname(path), { recursive: true });
    let existing = this.#read(path);
    if (!existing) {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, body, { flag: 'wx' });
        try {
          linkSync(temporaryPath, path);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } finally {
        try { unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      existing = this.#read(path);
    }
    if (!existing || !existing.equals(body)) throw new Error(`raw checksum collision or incomplete write: ${checksum}`);
    return Object.freeze({ checksum, objectPath: `file://${path}`, size: body.length });
  }

  get(checksum) {
    const body = this.#read(this.#path(checksum));
    return body ? Object.freeze({ checksum, objectPath: `file://${this.#path(checksum)}`, body }) : null;
  }

  has(checksum) { return this.verify(checksum).ok; }

  entries() {
    const entries = [];
    for (const directory of readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const directoryPath = join(this.root, directory.name);
      for (const file of readdirSync(directoryPath, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f0-9]{64}$/.test(file.name)) continue;
        const path = join(directoryPath, file.name);
        const body = this.#read(path);
        if (body) entries.push({ checksum: file.name, objectPath: `file://${path}`, size: body.length });
      }
    }
    return entries;
  }

  verify(checksum, expectedObjectPath) {
    const object = this.get(checksum);
    if (!object) return Object.freeze({ ok: false, reason: 'missing raw object', checksum });
    const actualChecksum = createHash('sha256').update(object.body).digest('hex');
    if (actualChecksum !== checksum) return Object.freeze({ ok: false, reason: 'raw object checksum mismatch', checksum, actualChecksum, objectPath: object.objectPath });
    if (expectedObjectPath && object.objectPath !== expectedObjectPath) {
      return Object.freeze({ ok: false, reason: 'raw object path mismatch', checksum, objectPath: object.objectPath, expectedObjectPath });
    }
    return Object.freeze({ ok: true, checksum, objectPath: object.objectPath, size: object.body.length });
  }

  #read(path) {
    try { return readFileSync(path); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #path(checksum) { return join(this.root, checksum.slice(0, 2), checksum); }
}
export function createRawStore(kind, root = '.raw') {
  if (kind === 'memory') return new MemoryRawStore();
  if (kind === 'filesystem') return new FileRawStore(root);
  throw new Error(`unsupported raw store: ${kind}. Expected memory or filesystem.`);
}

export class InMemoryPersistence {
  constructor(clock = () => new Date()) {
    this.clock = clock;
    this.jobs = new Map();
    this.sourceFetches = [];
    this.parseRuns = [];
    this.pages = new Map();
    this.observations = new Map();
    this.unavailableCoverage = new Map();
    this.reconciliationIssues = [];
    this.operatorDispositions = [];
    this.rawObjectRepairs = new Map();
    this.inFlight = new Map();
    this.requestSchedules = new Map();
    this.nextRequestId = 1;
  }

  addJob(job) {
    const validated = createJob(job);
    const existing = this.jobs.get(validated.key);
    if (existing) return existing;
    const now = this.clock().toISOString();
    const stored = { ...validated, state: 'pending', attempts: 0, createdAt: now, updatedAt: now };
    this.jobs.set(validated.key, stored);
    return stored;
  }

  listJobs() { return [...this.jobs.values()].map((job) => ({ ...job, claim: cloneClaim(job.claim) })); }
  getJob(key) {
    const job = this.jobs.get(key);
    return job ? { ...job, claim: cloneClaim(job.claim) } : null;
  }

  claimNextJob(now, workerId) {
    let current = this.#findClaimableJob(now);
    if (!current && this.recoverExpiredClaims(now) > 0) current = this.#findClaimableJob(now);
    if (!current) return null;
    const generation = (current.generation ?? 0) + 1;
    const lease = { workerId, generation, value: `${workerId}:${generation}` };
    current.generation = generation;
    current.state = 'fetching';
    current.attempts += 1;
    current.updatedAt = now.toISOString();
    current.claim = { owner: workerId, expiresAt: new Date(now.getTime() + 30_000).toISOString(), lease };
    return { ...current, lease };
  }

  renewClaim(key, lease, now) {
    const job = this.#requireLease(key, lease);
    job.claim.expiresAt = new Date(now.getTime() + 30_000).toISOString();
    job.updatedAt = now.toISOString();
  }

  recoverExpiredClaims(now) {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (!job.claim || new Date(job.claim.expiresAt) > now || this.inFlight.has(job.key)) continue;
      if (job.state === 'fetching' || job.state === 'fetched') {
        this.#applyTransition(job, 'retry_wait', { nextAllowedAt: now.toISOString(), lastError: 'claim expired before completion' }, now);
        recovered += 1;
      } else {
        job.claim = null;
      }
    }
    return recovered;
  }

  getRequestSchedule(host, now = this.clock()) {
    const current = this.requestSchedules.get(host) ?? { lastStartedAt: null, starts: [] };
    const starts = current.starts.filter((at) => now.getTime() - at.getTime() < 60_000);
    return { lastStartedAt: current.lastStartedAt, starts: [...starts] };
  }

  recordRequestStart(host, at) {
    const current = this.getRequestSchedule(host, at);
    current.starts.push(at);
    this.requestSchedules.set(host, { lastStartedAt: at, starts: current.starts });
  }

  recordFetch(metadata, lease) {
    this.#requireLease(metadata.jobKey, lease);
    const id = `fetch-${this.sourceFetches.length + 1}`;
    const record = Object.freeze({
      ...metadata,
      id,
      fetchedAt: metadata.fetchedAt ?? this.clock().toISOString(),
      etag: metadata.etag ?? null,
      lastModified: metadata.lastModified ?? null,
      recordedAt: this.clock().toISOString(),
    });
    this.sourceFetches.push(record);
    return id;
  }

  lastSuccessfulFetch(jobKey) {
    return this.sourceFetches.findLast((fetch) => fetch.jobKey === jobKey && fetch.checksum) ?? null;
  }

  repairRawObjects({ rawStore } = {}) {
    if (!rawStore || typeof rawStore.entries !== 'function' || typeof rawStore.verify !== 'function') {
      throw new Error('raw repair requires a raw store with entries() and verify().');
    }
    const observedAt = this.clock().toISOString();
    const references = new Map();
    for (const fetch of this.sourceFetches.filter((item) => item.checksum)) {
      const list = references.get(fetch.checksum) ?? [];
      list.push(fetch);
      references.set(fetch.checksum, list);
    }

    const healthy = [];
    const pending = [];
    for (const [checksum, fetches] of references) {
      const expectedPaths = [...new Set(fetches.map((fetch) => fetch.objectPath).filter(Boolean))];
      const expectedObjectPath = expectedPaths.length === 1 ? expectedPaths[0] : undefined;
      const verification = rawStore.verify(checksum, expectedObjectPath);
      if (verification.ok && expectedPaths.length <= 1) {
        healthy.push(Object.freeze({ checksum, objectPath: verification.objectPath, sourceFetchIds: fetches.map((fetch) => fetch.id) }));
        continue;
      }
      const reason = expectedPaths.length > 1 ? 'source fetches disagree about the raw object path' : verification.reason;
      const record = Object.freeze({
        checksum,
        objectPath: expectedObjectPath ?? verification.objectPath ?? expectedPaths[0] ?? 'missing',
        state: 'pending',
        observedAt,
        reason,
        sourceFetchIds: fetches.map((fetch) => fetch.id),
      });
      this.rawObjectRepairs.set(checksum, record);
      pending.push(record);
    }

    const orphans = [];
    for (const entry of rawStore.entries()) {
      if (references.has(entry.checksum)) continue;
      const verification = rawStore.verify(entry.checksum, entry.objectPath);
      const record = Object.freeze({
        checksum: entry.checksum,
        objectPath: entry.objectPath,
        state: 'retained',
        detectedAs: 'orphan',
        observedAt,
        reason: verification.ok ? 'orphan raw object retained for operator review' : `${verification.reason}; orphan retained for operator review`,
      });
      this.rawObjectRepairs.set(entry.checksum, record);
      orphans.push(record);
    }

    return Object.freeze({ observedAt, healthy: Object.freeze(healthy), pending: Object.freeze(pending), orphans: Object.freeze(orphans) });
  }

  recordParse(run, lease) {
    this.#requireLease(run.jobKey, lease);
    const id = `parse-${this.parseRuns.length + 1}`;
    const record = Object.freeze({
      ...run,
      id,
      warnings: run.warnings ?? [],
      failureDetails: run.failureDetails ?? null,
      parsedAt: run.parsedAt ?? this.clock().toISOString(),
      recordedAt: this.clock().toISOString(),
    });
    this.parseRuns.push(record);
    return id;
  }

  commitPage(page, provenance, lease) {
    this.#requireLease(page.jobKey, lease);
    const key = page.identity ?? page.jobKey;
    const record = Object.freeze({ ...page, provenance });
    const previous = this.pages.get(key);
    if (previous && !jsonEqual(previous.data, record.data)) {
      this.reconciliationIssues.push(createReconciliationIssue({
        issueType: 'conflicting_page_reprocess',
        recordKey: key,
        details: { previous: previous.data, current: record.data },
        status: 'open',
      }));
    }
    this.pages.set(key, record);
    for (const [index, observation] of (page.observations ?? []).entries()) {
      const observationKey = observation.key ?? `${observation.kind}:${observation.parentKey ?? page.jobKey}:${observation.rowIndex ?? observation.canonicalBoxScorePath ?? `row-${index}`}`;
      this.observations.set(observationKey, Object.freeze({ ...observation, provenance }));
    }
    for (const unavailable of page.unavailableCoverage ?? []) {
      const coverageKey = `${unavailable.schoolSourcePath}:${unavailable.endingYear}`;
      this.unavailableCoverage.set(coverageKey, Object.freeze({ ...unavailable, provenance }));
    }
    for (const child of page.childJobs ?? []) this.addJob(child);
    return key;
  }

  transitionJob(key, nextState, lease, details = {}) {
    const job = this.#requireLease(key, lease);
    this.#applyTransition(job, nextState, details);
  }

  recordOperatorDisposition(key, disposition) {
    const job = this.jobs.get(key);
    if (!job || job.state !== 'operator_stop') throw new Error(`operator disposition requires operator_stop. Current state: ${job?.state ?? 'missing'}`);
    const validated = createOperatorDisposition(
      disposition.kind,
      disposition.operatorId,
      disposition.reason,
      disposition.at ? new Date(disposition.at) : this.clock(),
    );
    this.operatorDispositions.push(Object.freeze({ jobKey: key, ...validated }));
    if (validated.kind === 'release_retry') this.#applyTransition(job, 'retry_wait', { nextAllowedAt: this.clock().toISOString() });
    if (validated.kind === 'release_permanent') this.#applyTransition(job, 'permanently_failed', { failureReason: validated.reason });
  }

  acquireRequest(key, lease, host) {
    this.#requireLease(key, lease);
    if ([...this.inFlight.values()].some((request) => request.host === host)) return null;
    const request = Object.freeze({ id: `request-${this.nextRequestId++}`, jobKey: key, host, lease });
    this.inFlight.set(key, request);
    return request;
  }

  releaseRequest(key, lease) {
    const request = this.inFlight.get(key);
    if (!request || !sameLease(request.lease, lease)) throw new Error('request ownership mismatch. Expected the current lease token before release. Example: workerId: worker-1');
    this.inFlight.delete(key);
  }

  queryModels() {
    const schools = [];
    const seasons = [];
    const games = [];
    for (const page of this.pages.values()) {
      if (page.kind === 'school_index') {
        for (const [rowIndex, school] of (page.data.schools ?? []).entries()) {
          const observation = this.observations.get(`school:${page.jobKey}:${rowIndex}`);
          if (typeof observation?.eligible !== 'boolean') {
            throw new Error(`school eligibility observation is missing for ${page.jobKey} row ${rowIndex}`);
          }
          schools.push({ ...school, eligible: observation.eligible, provenance: page.provenance });
        }
      }
      if (page.kind === 'season') seasons.push({ ...page.data, provenance: page.provenance });
      if (page.kind === 'game') games.push({ ...page.data, gameKey: page.identity, provenance: page.provenance });
    }
    const jobStates = {};
    for (const job of this.jobs.values()) jobStates[job.state] = (jobStates[job.state] ?? 0) + 1;
    return createQueryModels({
      schools,
      seasons,
      games,
      health: {
        jobStates,
        sourceFetches: this.sourceFetches.length,
        parseRuns: this.parseRuns.length,
        conflicts: this.reconciliationIssues.length,
        observations: this.observations.size,
      },
    });
  }

  #findClaimableJob(now) {
    for (const job of this.jobs.values()) {
      const retryReady = job.state === 'retry_wait' && job.nextAllowedAt && new Date(job.nextAllowedAt) <= now;
      if (!job.claim && (job.state === 'pending' || retryReady)) return job;
    }
    return null;
  }

  #applyTransition(job, nextState, details, at = this.clock()) {
    assertTransition(job.state, nextState);
    job.state = nextState;
    Object.assign(job, details);
    job.updatedAt = at.toISOString();
    if (['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed'].includes(nextState)) job.claim = null;
  }

  #requireLease(key, lease) {
    const job = this.jobs.get(key);
    if (!job || !job.claim || !sameLease(job.claim.lease, lease) || new Date(job.claim.expiresAt) <= this.clock()) {
      throw new Error(`stale or missing lease for job ${key}. Expected the current unexpired lease token.`);
    }
    return job;
  }
}
