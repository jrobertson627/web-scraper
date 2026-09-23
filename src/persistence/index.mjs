import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { platform } from 'node:os';
import {
  FAILURE_STATES,
  assertTransition,
  createJobStateEvent,
  createLeaseToken,
  createOperatorDisposition,
  sameLease,
} from '../contracts/jobs.mjs';
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

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function assertChecksum(checksum) {
  if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    throw new Error('raw checksum is invalid. Expected a lowercase SHA-256 hex digest.');
  }
  return checksum;
}

function assertRawReference({ checksum, objectPath }) {
  assertChecksum(checksum);
  if (typeof objectPath !== 'string' || !objectPath) throw new Error('raw object path is missing. Expected the immutable store reference.');
}

function cloneClaim(claim) {
  return claim ? { ...claim, lease: claim.lease ? { ...claim.lease } : claim.lease } : null;
}

function cloneJob(job) {
  return {
    ...job,
    claim: cloneClaim(job.claim),
    history: (job.history ?? []).map((event) => ({ ...event, details: { ...event.details } })),
    failures: (job.failures ?? []).map((failure) => ({ ...failure, details: { ...failure.details } })),
  };
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
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return null;
    const object = this.#objects.get(checksum);
    return object ? Object.freeze({ ...object, body: Buffer.from(object.body) }) : null;
  }

  has(checksum) { return this.verify(checksum).ok; }
  entries() { return [...this.#objects.values()].map(({ checksum, objectPath, body }) => ({ checksum, objectPath, size: body.length })); }

  verify(checksum, expectedObjectPath) {
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return Object.freeze({ ok: false, reason: 'invalid raw checksum', checksum });
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
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('filesystem raw store requires an absolute root path');
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.#requireDirectory(this.root);
  }

  put(bytes) {
    const body = Buffer.from(bytes);
    const checksum = createHash('sha256').update(body).digest('hex');
    const path = this.#path(checksum);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    this.#requireDirectory(directory);
    let existing = this.#read(path);
    if (!existing) {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = openSync(temporaryPath, 'wx');
        try {
          writeFileSync(handle, body);
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
        try {
          linkSync(temporaryPath, path);
          this.#syncDirectory(directory);
          this.#syncDirectory(this.root);
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
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return null;
    let body;
    try { body = this.#read(this.#path(checksum)); } catch { return null; }
    if (body && createHash('sha256').update(body).digest('hex') !== checksum) return null;
    return body ? Object.freeze({ checksum, objectPath: `file://${this.#path(checksum)}`, body }) : null;
  }

  has(checksum) { return this.verify(checksum).ok; }

  entries() {
    const entries = [];
    for (const directory of readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) continue;
      const directoryPath = join(this.root, directory.name);
      this.#requireDirectory(directoryPath);
      for (const file of readdirSync(directoryPath, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f0-9]{64}$/.test(file.name) || !file.name.startsWith(directory.name)) continue;
        const path = join(directoryPath, file.name);
        const body = this.#read(path);
        if (body) entries.push({ checksum: file.name, objectPath: `file://${path}`, size: body.length });
      }
    }
    return entries;
  }

  temporaryEntries() {
    const entries = [];
    for (const directory of readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) continue;
      const directoryPath = join(this.root, directory.name);
      this.#requireDirectory(directoryPath);
      for (const file of readdirSync(directoryPath, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.\d+\.[a-f0-9-]+\.tmp$/.exec(file.name);
        if (!file.isFile() || !match || !match[1].startsWith(directory.name)) continue;
        const path = join(directoryPath, file.name);
        try {
          entries.push(Object.freeze({ checksum: match[1], objectPath: `file://${path}`, modifiedAt: lstatSync(path).mtime.toISOString() }));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return entries.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
  }

  verify(checksum, expectedObjectPath) {
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return Object.freeze({ ok: false, reason: 'invalid raw checksum', checksum });
    let body;
    try { body = this.#read(this.#path(checksum)); } catch (error) {
      return Object.freeze({ ok: false, reason: `unsafe raw object: ${error.message}`, checksum });
    }
    if (!body) return Object.freeze({ ok: false, reason: 'missing raw object', checksum });
    const objectPath = `file://${this.#path(checksum)}`;
    const actualChecksum = createHash('sha256').update(body).digest('hex');
    if (actualChecksum !== checksum) return Object.freeze({ ok: false, reason: 'raw object checksum mismatch', checksum, actualChecksum, objectPath });
    if (expectedObjectPath && objectPath !== expectedObjectPath) {
      return Object.freeze({ ok: false, reason: 'raw object path mismatch', checksum, objectPath, expectedObjectPath });
    }
    return Object.freeze({ ok: true, checksum, objectPath, size: body.length });
  }

  #read(path) {
    try {
      this.#requireDirectory(dirname(path));
      if (!lstatSync(path).isFile()) throw new Error(`raw object is not a regular file: ${path}`);
      return readFileSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #requireDirectory(path) {
    if (!lstatSync(path).isDirectory()) throw new Error(`raw store directory is not a real directory: ${path}`);
  }

  #syncDirectory(path) {
    if (platform() === 'win32') return; // Node cannot portably open Windows directory handles for fsync.
    const handle = openSync(path, 'r');
    try { fsyncSync(handle); } finally { closeSync(handle); }
  }

  #path(checksum) { return join(this.root, checksum.slice(0, 2), checksum); }
}
export function createRawStore(kind, root) {
  if (kind === 'memory') return new MemoryRawStore();
  if (kind === 'filesystem') return new FileRawStore(root);
  throw new Error(`unsupported raw store: ${kind}. Expected memory or filesystem.`);
}

export class InMemoryPersistence {
  constructor(clock = () => new Date(), {
    authorizeOperator = (operatorId) => Boolean(operatorId),
    claimTimeoutMs = 30_000,
  } = {}) {
    this.clock = clock;
    this.authorizeOperator = authorizeOperator;
    this.claimTimeoutMs = claimTimeoutMs;
    this.jobs = new Map();
    this.sourceFetches = [];
    this.parseRuns = [];
    this.pages = new Map();
    this.observations = new Map();
    this.observationHistory = [];
    this.unavailableCoverage = new Map();
    this.reconciliationIssues = [];
    this.operatorDispositions = [];
    this.rawObjectRepairs = new Map();
    this.inFlight = new Map();
    this.requestHistory = [];
    this.requestSchedules = new Map();
    this.nextRequestId = 1;
  }

  addJob(job) {
    const validated = createJob(job);
    const existing = this.jobs.get(validated.key);
    if (existing) return existing;
    const now = this.clock().toISOString();
    const stored = { ...validated, state: 'pending', attempts: 0, createdAt: now, updatedAt: now, history: [], failures: [] };
    this.jobs.set(validated.key, stored);
    return stored;
  }

  listJobs() { return [...this.jobs.values()].map(cloneJob); }
  getJob(key) {
    const job = this.jobs.get(key);
    return job ? cloneJob(job) : null;
  }

  claimNextJob(now, workerId) {
    let current = this.#findClaimableJob(now);
    if (!current && this.recoverExpiredClaims(now) > 0) current = this.#findClaimableJob(now);
    if (!current) return null;
    const previousState = current.state;
    const generation = (current.generation ?? 0) + 1;
    const lease = createLeaseToken(workerId, generation);
    current.generation = generation;
    current.state = 'fetching';
    current.attempts += 1;
    current.updatedAt = now.toISOString();
    current.claim = { owner: workerId, expiresAt: new Date(now.getTime() + this.claimTimeoutMs).toISOString(), lease };
    current.history.push(createJobStateEvent({
      from: previousState,
      to: 'fetching',
      at: now,
      attempts: current.attempts,
      lease,
      details: { owner: workerId },
    }));
    return { ...cloneJob(current), lease };
  }

  renewClaim(key, lease, now) {
    const job = this.#requireLease(key, lease);
    job.claim.expiresAt = new Date(now.getTime() + this.claimTimeoutMs).toISOString();
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

  recordFetch(metadata, lease, rawStore) {
    this.#requireLease(metadata.jobKey, lease);
    const successful = (Number.isInteger(metadata.status) && metadata.status >= 200 && metadata.status < 300) || metadata.status === 304;
    if (successful) {
      assertRawReference(metadata);
      if (!rawStore || typeof rawStore.verify !== 'function') {
        throw new Error('successful fetch requires a raw store for durable verification');
      }
    }
    if (rawStore && metadata.checksum) {
      const verification = rawStore.verify(metadata.checksum, metadata.objectPath);
      if (!verification.ok) throw new Error(`raw fetch metadata rejected before durable record: ${verification.reason}`);
    }
    const id = `fetch-${this.sourceFetches.length + 1}`;
    const record = Object.freeze({
      ...metadata,
      id,
      fetchedAt: metadata.fetchedAt ?? this.clock().toISOString(),
      etag: metadata.etag ?? null,
      lastModified: metadata.lastModified ?? null,
      cacheControl: metadata.cacheControl ?? null,
      cacheHit: metadata.cacheHit ?? false,
      reusedBody: metadata.reusedBody ?? false,
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
      if (verification.ok && expectedPaths.length === 1 && fetches.every((fetch) => fetch.objectPath === expectedObjectPath)) {
        healthy.push(Object.freeze({ checksum, objectPath: verification.objectPath, sourceFetchIds: fetches.map((fetch) => fetch.id) }));
        continue;
      }
      const reason = expectedPaths.length > 1 ? 'source fetches disagree about the raw object path'
        : fetches.some((fetch) => !fetch.objectPath) ? 'source fetch is missing a raw object path'
          : verification.reason;
      const defect = expectedPaths.length > 1 ? 'path_conflict'
        : fetches.some((fetch) => !fetch.objectPath) ? 'missing_path'
          : verification.reason === 'missing raw object' ? 'missing'
            : verification.reason === 'raw object checksum mismatch' ? 'checksum_mismatch'
              : 'invalid_reference';
      const record = Object.freeze({
        checksum,
        objectPath: expectedObjectPath ?? verification.objectPath ?? expectedPaths[0] ?? 'missing',
        state: 'pending',
        defect,
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

    healthy.sort((left, right) => left.checksum.localeCompare(right.checksum));
    pending.sort((left, right) => left.checksum.localeCompare(right.checksum));
    orphans.sort((left, right) => left.checksum.localeCompare(right.checksum));
    const temporary = rawStore.temporaryEntries?.() ?? [];
    return Object.freeze({
      observedAt,
      counts: Object.freeze({ healthy: healthy.length, pending: pending.length, orphans: orphans.length, temporary: temporary.length }),
      healthy: Object.freeze(healthy),
      pending: Object.freeze(pending),
      orphans: Object.freeze(orphans),
      temporary: Object.freeze(temporary),
    });
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
    if (this.inFlight.has(page.jobKey)) throw new Error(`cannot commit page ${page.jobKey} while its host request is still active`);
    const staged = this.#stagePage(page, provenance);
    this.#installPage(staged);
    return staged.key;
  }

  commitPageAndTransition(page, provenance, lease) {
    this.#requireLease(page.jobKey, lease);
    if (this.inFlight.has(page.jobKey)) throw new Error(`cannot commit page ${page.jobKey} while its host request is still active`);
    const staged = this.#stagePage(page, provenance);
    const job = cloneJob(staged.jobs.get(page.jobKey));
    this.#applyTransition(job, 'parsed', {});
    staged.jobs.set(page.jobKey, job);
    this.#installPage(staged);
    return Object.freeze({ key: staged.key, conflict: staged.conflict });
  }

  #stagePage(page, provenance) {
    const key = page.identity ?? page.jobKey;
    const record = Object.freeze({ ...page, provenance });
    const previous = this.pages.get(key);
    const conflict = Boolean(previous && !jsonEqual(previous.data, record.data));
    const pages = new Map(this.pages);
    const observations = new Map(this.observations);
    const observationHistory = [...this.observationHistory];
    const unavailableCoverage = new Map(this.unavailableCoverage);
    const reconciliationIssues = [...this.reconciliationIssues];
    const jobs = new Map(this.jobs);
    if (conflict) {
      reconciliationIssues.push(createReconciliationIssue({
        issueType: 'conflicting_page_reprocess',
        recordKey: key,
        details: {
          previous: { data: previous.data, provenance: previous.provenance },
          current: { data: record.data, provenance: record.provenance },
        },
        status: 'open',
      }));
    } else {
      pages.set(key, record);
    }
    for (const [index, observation] of (page.observations ?? []).entries()) {
      const observationKey = observation.key ?? `${observation.kind}:${observation.parentKey ?? page.jobKey}:${observation.rowIndex ?? observation.canonicalBoxScorePath ?? `row-${index}`}`;
      const storedObservation = Object.freeze({ ...observation, provenance });
      if (!observationHistory.some((entry) => jsonEqual(entry, storedObservation))) observationHistory.push(storedObservation);
      if (!conflict) observations.set(observationKey, storedObservation);
    }
    if (!conflict) {
      for (const unavailable of page.unavailableCoverage ?? []) {
        const coverageKey = `${unavailable.schoolSourcePath}:${unavailable.endingYear}`;
        unavailableCoverage.set(coverageKey, Object.freeze({ ...unavailable, provenance }));
      }
      for (const child of page.childJobs ?? []) {
        const validated = createJob(child);
        if (jobs.has(validated.key)) continue;
        const now = this.clock().toISOString();
        jobs.set(validated.key, { ...validated, state: 'pending', attempts: 0, createdAt: now, updatedAt: now, history: [], failures: [] });
      }
    }
    return { key, conflict, pages, observations, observationHistory, unavailableCoverage, reconciliationIssues, jobs };
  }

  #installPage(staged) {
    this.pages = staged.pages;
    this.observations = staged.observations;
    this.observationHistory = staged.observationHistory;
    this.unavailableCoverage = staged.unavailableCoverage;
    this.reconciliationIssues = staged.reconciliationIssues;
    this.jobs = staged.jobs;
  }

  transitionJob(key, nextState, lease, details = {}) {
    const job = this.#requireLease(key, lease);
    if (this.inFlight.has(key)) throw new Error(`cannot transition job ${key} while its host request is still active`);
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
    if (!this.authorizeOperator(validated.operatorId, validated)) {
      throw new Error(`operator ${validated.operatorId} is not authorized to review operator-stop work`);
    }
    this.operatorDispositions.push(Object.freeze({ jobKey: key, ...validated }));
    job.history.push(Object.freeze({ type: 'operator_disposition', state: job.state, at: validated.at, operatorId: validated.operatorId, disposition: validated.kind, reason: validated.reason }));
    if (validated.kind === 'release_retry') this.#applyTransition(job, 'retry_wait', { nextAllowedAt: this.clock().toISOString(), lastError: validated.reason });
    if (validated.kind === 'release_permanent') this.#applyTransition(job, 'permanently_failed', { failureReason: validated.reason });
  }

  acquireRequest(key, lease, host) {
    this.#requireLease(key, lease);
    if ([...this.inFlight.values()].some((request) => request.host === host)) return null;
    const job = this.jobs.get(key);
    const request = Object.freeze({
      id: `request-${this.nextRequestId++}`,
      jobKey: key,
      providerId: job.sourceUrl.providerId,
      host,
      lease,
      startedAt: this.clock().toISOString(),
    });
    this.inFlight.set(key, request);
    return request;
  }

  releaseRequest(key, lease) {
    const request = this.inFlight.get(key);
    if (!request || !sameLease(request.lease, lease)) throw new Error('request ownership mismatch. Expected the current lease token before release. Example: workerId: worker-1');
    this.inFlight.delete(key);
    this.requestHistory.push(Object.freeze({ ...request, outcome: 'completed', releasedAt: this.clock().toISOString() }));
  }

  confirmRequestCancellation(key, lease, reason) {
    const request = this.inFlight.get(key);
    if (!request || !sameLease(request.lease, lease)) throw new Error('request cancellation requires the current request ownership token');
    if (!reason) throw new Error('request cancellation confirmation requires a reason');
    this.inFlight.delete(key);
    const record = Object.freeze({ ...request, outcome: 'canceled', cancellationReason: reason, releasedAt: this.clock().toISOString() });
    this.requestHistory.push(record);
    return record;
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
        warnings: this.parseRuns.reduce((total, run) => total + (run.warnings?.length ?? 0), 0),
        unavailableCoverage: this.unavailableCoverage.size,
        conflicts: this.reconciliationIssues.length,
        observations: this.observations.size,
      },
    });
  }

  #findClaimableJob(now) {
    for (const job of this.jobs.values()) {
      const retryReady = job.state === 'retry_wait' && job.nextAllowedAt && new Date(job.nextAllowedAt) <= now;
      const parentComplete = !job.parentKey || this.jobs.get(job.parentKey)?.state === 'parsed';
      if (parentComplete && !job.claim && (job.state === 'pending' || retryReady)) return job;
    }
    return null;
  }

  #applyTransition(job, nextState, details, at = this.clock()) {
    const previousState = job.state;
    assertTransition(job.state, nextState);
    job.state = nextState;
    Object.assign(job, details);
    job.updatedAt = at.toISOString();
    job.history.push(createJobStateEvent({ from: previousState, to: nextState, at, attempts: job.attempts, lease: job.claim?.lease, details }));
    if (FAILURE_STATES.includes(nextState)) {
      job.failures.push(Object.freeze({
        state: nextState,
        at: at.toISOString(),
        attempts: job.attempts,
        reason: details.lastError ?? details.failureReason ?? 'unspecified failure',
        details: Object.freeze({ ...details }),
      }));
    }
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
