import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { platform } from 'node:os';
import {
  FAILURE_STATES,
  assertTransition,
  createJobStateEvent,
  createLeaseToken,
  createOperatorDisposition,
  REFRESH_PAGE_TYPES,
  sameLease,
} from '../contracts/jobs.mjs';
import {
  createJob, createPageRequest, createQueryModels, createReadPage, createReconciliationIssue, decodePageCursor, deepFreeze,
} from '../contracts/boundaries.mjs';
import {
  DEFAULT_MAX_CLAIM_RECOVERIES, DEFAULT_ORPHAN_GRACE_MS, DENY_ALL_OPERATORS, HALTING_STOP_CODES, HOST_BUSY_WAIT_MS, ORPHANED_REQUEST_REASON,
  REPROCESS_STATES, REVIEWABLE_JOB_STATES, REVIEW_JOB_STATES, createReviewDisposition, positiveInteger,
} from '../contracts/jobs.mjs';
import { PAGE_TYPES } from '../contracts/source.mjs';
import { FULL_CRAWL_SCOPE, nextCrawlScope } from '../contracts/crawl-scope.mjs';
import { MAX_REQUEST_TIMEOUT_MS } from '../contracts/request-policy.mjs';

const CLAIM_EXPIRED = 'claim expired before completion';

function newJobRecord(validated, now) {
  return { ...validated, state: 'pending', attempts: 0, failureAttempts: 0, rateLimitAttempts: 0, claimRecoveries: 0,
    createdAt: now, updatedAt: now, history: [], failures: [] };
}

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

// A raw object is recorded by a reference that does not depend on where a store
// keeps it: `raw:<first two hex digits>/<checksum>` (#117). The store resolves it
// to a location when it reads, so moving the store to another root or to object
// storage leaves every recorded reference valid. Before #117 the reference was
// the absolute path the worker wrote (`file:///var/data/raw/xx/<checksum>`);
// normalizeObjectReference reads those as the same object.
const OBJECT_KEY_PATTERN = /^raw:[a-f0-9]{2}\/[a-f0-9]{64}$/;

export function rawObjectKey(checksum) {
  return `raw:${assertChecksum(checksum).slice(0, 2)}/${checksum}`;
}

// The reference for a recorded value: a key stays as it is, a legacy file:// or
// memory:// path becomes the key of the object it names, anything else is left
// alone so it is reported as a mismatch rather than guessed at.
export function normalizeObjectReference(reference) {
  if (typeof reference !== 'string' || OBJECT_KEY_PATTERN.test(reference)) return reference;
  const legacy = /^(?:file|memory):\/\/(?:.*[\\/])?([a-f0-9]{64})$/.exec(reference);
  return legacy ? rawObjectKey(legacy[1]) : reference;
}

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

// The raw repair inventory both adapters return (RAW_STORAGE.md). fetches are
// the recorded source fetches, { id, checksum, objectPath }; the store is only
// read. Referenced objects are healthy or pending repair, with a defect;
// unreferenced objects are orphans retained for review; interrupted writes are
// listed as temporary files.
export async function inventoryRawObjects({ rawStore, fetches, observedAt }) {
  if (!rawStore || typeof rawStore.entries !== 'function' || typeof rawStore.verify !== 'function') {
    throw new Error('raw repair requires a raw store with entries() and verify().');
  }
  const references = new Map();
  for (const fetch of fetches.filter((item) => item.checksum)) {
    const list = references.get(fetch.checksum) ?? [];
    list.push(fetch);
    references.set(fetch.checksum, list);
  }

  const healthy = [];
  const pending = [];
  for (const [checksum, referencing] of references) {
    const expectedPaths = [...new Set(referencing.map((fetch) => normalizeObjectReference(fetch.objectPath)).filter(Boolean))];
    const expectedObjectPath = expectedPaths.length === 1 ? expectedPaths[0] : undefined;
    const verification = await rawStore.verify(checksum, expectedObjectPath);
    if (verification.ok && expectedPaths.length === 1 && referencing.every((fetch) => normalizeObjectReference(fetch.objectPath) === expectedObjectPath)) {
      healthy.push(Object.freeze({ checksum, objectPath: verification.objectPath, sourceFetchIds: referencing.map((fetch) => fetch.id) }));
      continue;
    }
    const reason = expectedPaths.length > 1 ? 'source fetches disagree about the raw object path'
      : referencing.some((fetch) => !fetch.objectPath) ? 'source fetch is missing a raw object path'
        : verification.reason;
    const defect = expectedPaths.length > 1 ? 'path_conflict'
      : referencing.some((fetch) => !fetch.objectPath) ? 'missing_path'
        : verification.reason === 'missing raw object' ? 'missing'
          : verification.reason === 'raw object checksum mismatch' ? 'checksum_mismatch'
            : 'invalid_reference';
    pending.push(Object.freeze({
      checksum,
      objectPath: expectedObjectPath ?? verification.objectPath ?? expectedPaths[0] ?? 'missing',
      state: 'pending',
      defect,
      observedAt,
      reason,
      sourceFetchIds: referencing.map((fetch) => fetch.id),
    }));
  }

  const orphans = [];
  for (const entry of await rawStore.entries()) {
    if (references.has(entry.checksum)) continue;
    const verification = await rawStore.verify(entry.checksum, entry.objectPath);
    orphans.push(Object.freeze({
      checksum: entry.checksum,
      objectPath: entry.objectPath,
      state: 'retained',
      detectedAs: 'orphan',
      observedAt,
      reason: verification.ok ? 'orphan raw object retained for operator review' : `${verification.reason}; orphan retained for operator review`,
    }));
  }

  const byChecksum = (left, right) => left.checksum.localeCompare(right.checksum);
  healthy.sort(byChecksum);
  pending.sort(byChecksum);
  orphans.sort(byChecksum);
  const temporary = (await rawStore.temporaryEntries?.()) ?? [];
  return Object.freeze({
    observedAt,
    counts: Object.freeze({ healthy: healthy.length, pending: pending.length, orphans: orphans.length, temporary: temporary.length }),
    healthy: Object.freeze(healthy),
    pending: Object.freeze(pending),
    orphans: Object.freeze(orphans),
    temporary: Object.freeze(temporary),
  });
}

export function assertReviewStates(states) {
  if (!Array.isArray(states) || !states.length || states.some((state) => !REVIEWABLE_JOB_STATES.includes(state))) {
    throw new Error(`review states are invalid. Expected some of ${REVIEWABLE_JOB_STATES.join(', ')}. Example: parse_failed`);
  }
}

// The fields of a job the review list shows; both adapters add the latest parse
// run, snapshot and dispositions.
export function reviewJobSummary(job) {
  return {
    key: job.key, pageType: job.pageType, state: job.state, url: job.sourceUrl.absoluteUrl,
    parentKey: job.parentKey ?? null, attempts: job.attempts, updatedAt: job.updatedAt,
    reason: job.failures?.at(-1)?.reason ?? job.lastError ?? null,
    // The code the job's latest stop or failure carried, such as challenge or rate_limit_cap.
    code: [...(job.history ?? [])].reverse().find((event) => event.to === job.state && event.details?.code)?.details.code ?? null,
    history: (job.history ?? []).map((event) => ({ ...event })),
  };
}

export function assertReprocessSelection(pageTypes, states) {
  if (!Array.isArray(pageTypes) || !pageTypes.length || pageTypes.some((pageType) => !PAGE_TYPES.includes(pageType))) {
    throw new Error(`reprocess page types are invalid. Expected some of ${PAGE_TYPES.join(', ')}. Example: box_score`);
  }
  if (!Array.isArray(states) || !states.length || states.some((state) => !REPROCESS_STATES.includes(state))) {
    throw new Error(`reprocess states are invalid. Expected some of ${REPROCESS_STATES.join(', ')}. Example: parse_failed`);
  }
}

// Both adapters check a fetch's raw reference against the verification the
// raw store returned for that body (from put or read) rather than reading and
// hashing it again (#91). A successful (2xx or 304) fetch must carry a passing
// verification of exactly its checksum and object path.
export function assertFetchVerification(metadata, verification) {
  const successful = (Number.isInteger(metadata.status) && metadata.status >= 200 && metadata.status < 300) || metadata.status === 304;
  if (successful) {
    assertRawReference(metadata);
    if (!verification) throw new Error('successful fetch requires the raw store verification of its body');
  }
  if (!verification || !metadata.checksum) return;
  if (!verification.ok) throw new Error(`raw fetch metadata rejected before durable record: ${verification.reason}`);
  if (verification.checksum !== metadata.checksum || verification.objectPath !== normalizeObjectReference(metadata.objectPath)) {
    throw new Error('raw fetch metadata rejected before durable record: verification is for a different raw object');
  }
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

function compareKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

// entries are { key, item() }; only the rows of the returned page are built.
function memoryPage(entries, request, shape) {
  const { limit, cursor } = createPageRequest(request);
  const after = decodePageCursor(cursor, shape);
  const ordered = entries.filter((entry) => !after || compareKeys(entry.key, after) > 0).sort((a, b) => compareKeys(a.key, b.key));
  return createReadPage(ordered.slice(0, limit + 1), limit, (entry) => entry.key, (entry) => entry.item());
}

// The fields of a job the reconciliation report uses; both adapters return this shape.
export function reconciliationJob(job) {
  return deepFreeze({ key: job.key, pageType: job.pageType, state: job.state, parentKey: job.parentKey ?? null,
    schoolSourcePath: job.schoolSourcePath ?? null, sourceUrl: job.sourceUrl, canonicalPath: job.canonicalPath,
    reason: job.failures?.at(-1)?.reason ?? job.lastError ?? null });
}

function memoryIssue(issue) {
  return deepFreeze({ id: issue.id, issueType: issue.issueType, recordKey: issue.recordKey, status: issue.status,
    openedAt: issue.openedAt ?? null, details: issue.details });
}

function gameModel(page) {
  return { ...page.data, gameKey: page.identity, provenance: page.provenance };
}

const RAW_STORE_ID_FILE = '.raw-store-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256(body) { return createHash('sha256').update(body).digest('hex'); }

// A raw store's verification of one object: { ok: true, checksum, objectPath,
// size } or { ok: false, reason, ... }. read() adds the verified body. put()
// and read() each hash the body once, and callers pass their result along
// (recordFetch takes it as proof) instead of hashing again (#91).
function checkedObject(checksum, objectPath, body, expectedObjectPath) {
  const actualChecksum = sha256(body);
  if (actualChecksum !== checksum) return Object.freeze({ ok: false, reason: 'raw object checksum mismatch', checksum, actualChecksum, objectPath });
  if (expectedObjectPath && objectPath !== normalizeObjectReference(expectedObjectPath)) {
    return Object.freeze({ ok: false, reason: 'raw object path mismatch', checksum, objectPath, expectedObjectPath });
  }
  return Object.freeze({ ok: true, checksum, objectPath, size: body.length, body });
}

function withoutBody({ body, ...verification }) { return Object.freeze(verification); }

// The in-memory store does no I/O, so its methods return values directly; the
// filesystem store's return promises. Callers await either.
export class MemoryRawStore {
  #objects = new Map();
  #storeId = randomUUID();

  // Identifies this store, as the filesystem store's marker file does.
  storeId() { return this.#storeId; }

  // The in-memory store cannot fill a disk.
  freeBytes() { return Number.POSITIVE_INFINITY; }

  put(bytes) {
    const body = Buffer.from(bytes);
    const checksum = sha256(body);
    const existing = this.#objects.get(checksum);
    if (existing && !existing.body.equals(body)) throw new Error(`raw checksum collision: ${checksum}`);
    if (!existing) this.#objects.set(checksum, { checksum, body, objectPath: rawObjectKey(checksum) });
    return Object.freeze({ ok: true, checksum, objectPath: rawObjectKey(checksum), size: body.length });
  }

  read(checksum, expectedObjectPath) {
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return Object.freeze({ ok: false, reason: 'invalid raw checksum', checksum });
    const object = this.#objects.get(checksum);
    if (!object) return Object.freeze({ ok: false, reason: 'missing raw object', checksum });
    return checkedObject(checksum, object.objectPath, Buffer.from(object.body), expectedObjectPath);
  }

  get(checksum) {
    const read = this.read(checksum);
    return read.ok ? Object.freeze({ checksum, objectPath: read.objectPath, body: read.body }) : null;
  }

  has(checksum) { return this.verify(checksum).ok; }
  entries() { return [...this.#objects.values()].map(({ checksum, objectPath, body }) => ({ checksum, objectPath, size: body.length })); }
  verify(checksum, expectedObjectPath) { return withoutBody(this.read(checksum, expectedObjectPath)); }
}

// Asynchronous filesystem I/O, so a large write or read does not block the
// event loop (and with it the worker's lease-renewal timer).
export class FileRawStore {
  constructor(root) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('filesystem raw store requires an absolute root path');
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    if (!lstatSync(this.root).isDirectory()) throw new Error(`raw store directory is not a real directory: ${this.root}`);
  }

  // Returns the verification of the stored object. The body is hashed once; a
  // byte comparison, not a second hash, proves the stored file is this body.
  async put(bytes) {
    const body = Buffer.from(bytes);
    const checksum = sha256(body);
    const path = this.#path(checksum);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    await this.#requireDirectory(directory);
    let existing = await this.#read(path);
    if (!existing) {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporaryPath, 'wx');
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporaryPath, path);
          await this.#syncDirectory(directory);
          await this.#syncDirectory(this.root);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } finally {
        try { await unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      existing = await this.#read(path);
    }
    if (!existing || !existing.equals(body)) throw new Error(`raw checksum collision or incomplete write: ${checksum}`);
    return Object.freeze({ ok: true, checksum, objectPath: rawObjectKey(checksum), size: body.length });
  }

  // The bytes available to write on the disk the store lives on (#114); the run
  // halts before a request when this is below its minimum.
  async freeBytes() {
    const stats = await statfs(this.root);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  // Identifies this store: a UUID kept in a marker file at its root, created the
  // first time it is asked for. A database records the id of the store it was
  // crawled with, so a worker pointed at another store refuses to start (#117).
  // Copying the store's directory, marker included, to a new root or machine keeps
  // its identity.
  async storeId() {
    const path = join(this.root, RAW_STORE_ID_FILE);
    const read = async () => {
      const text = (await readFile(path, 'utf8')).trim();
      if (!UUID_PATTERN.test(text)) throw new Error(`raw store id file ${RAW_STORE_ID_FILE} is malformed. Expected a UUID`);
      return text;
    };
    try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      await writeFile(path, `${randomUUID()}\n`, { flag: 'wx' });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return read();
  }

  async read(checksum, expectedObjectPath) {
    if (!CHECKSUM_PATTERN.test(checksum ?? '')) return Object.freeze({ ok: false, reason: 'invalid raw checksum', checksum });
    let body;
    try { body = await this.#read(this.#path(checksum)); } catch (error) {
      return Object.freeze({ ok: false, reason: `unsafe raw object: ${error.message}`, checksum });
    }
    if (!body) return Object.freeze({ ok: false, reason: 'missing raw object', checksum });
    return checkedObject(checksum, rawObjectKey(checksum), body, expectedObjectPath);
  }

  async get(checksum) {
    const read = await this.read(checksum);
    return read.ok ? Object.freeze({ checksum, objectPath: read.objectPath, body: read.body }) : null;
  }

  async has(checksum) { return (await this.verify(checksum)).ok; }
  async verify(checksum, expectedObjectPath) { return withoutBody(await this.read(checksum, expectedObjectPath)); }

  // Sizes come from lstat, so an inventory does not read every body.
  async entries() {
    const entries = [];
    for (const { directoryPath, directoryName, file } of await this.#shardFiles()) {
      if (!file.isFile() || !/^[a-f0-9]{64}$/.test(file.name) || !file.name.startsWith(directoryName)) continue;
      const path = join(directoryPath, file.name);
      const stats = await lstatIfPresent(path);
      if (stats?.isFile()) entries.push({ checksum: file.name, objectPath: rawObjectKey(file.name), size: stats.size });
    }
    return entries;
  }

  async temporaryEntries() {
    const entries = [];
    for (const { directoryPath, directoryName, file } of await this.#shardFiles()) {
      const match = /^([a-f0-9]{64})\.\d+\.[a-f0-9-]+\.tmp$/.exec(file.name);
      if (!file.isFile() || !match || !match[1].startsWith(directoryName)) continue;
      const path = join(directoryPath, file.name);
      const stats = await lstatIfPresent(path);
      // Relative to the store's root, since an interrupted write has no object key.
      if (stats) entries.push(Object.freeze({ checksum: match[1], objectPath: `raw:${directoryName}/${file.name}`, modifiedAt: stats.mtime.toISOString() }));
    }
    return entries.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
  }

  // Every file in the two-hex-digit shard directories, which must be real directories.
  async #shardFiles() {
    const files = [];
    for (const directory of await readdir(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) continue;
      const directoryPath = join(this.root, directory.name);
      await this.#requireDirectory(directoryPath);
      for (const file of await readdir(directoryPath, { withFileTypes: true })) files.push({ directoryPath, directoryName: directory.name, file });
    }
    return files;
  }

  async #read(path) {
    try {
      await this.#requireDirectory(dirname(path));
      if (!(await lstat(path)).isFile()) throw new Error(`raw object is not a regular file: ${path}`);
      return await readFile(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #requireDirectory(path) {
    if (!(await lstat(path)).isDirectory()) throw new Error(`raw store directory is not a real directory: ${path}`);
  }

  async #syncDirectory(path) {
    if (platform() === 'win32') return; // Node cannot portably open Windows directory handles for fsync.
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  #path(checksum) { return join(this.root, checksum.slice(0, 2), checksum); }
}

async function lstatIfPresent(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function createRawStore(kind, root) {
  if (kind === 'memory') return new MemoryRawStore();
  if (kind === 'filesystem') return new FileRawStore(root);
  throw new Error(`unsupported raw store: ${kind}. Expected memory or filesystem.`);
}

export class InMemoryPersistence {
  // authorizeOperator decides who may record an operator disposition. The
  // default denies everyone; see src/config/operators.mjs.
  constructor(clock = () => new Date(), {
    authorizeOperator = DENY_ALL_OPERATORS,
    claimTimeoutMs = 30_000,
    maxClaimRecoveries = DEFAULT_MAX_CLAIM_RECOVERIES,
    // At least the workers' request policy timeout; the default is the
    // largest timeout a policy may set.
    requestTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  } = {}) {
    this.clock = clock;
    this.authorizeOperator = authorizeOperator;
    this.claimTimeoutMs = claimTimeoutMs;
    this.maxClaimRecoveries = positiveInteger('maxClaimRecoveries', maxClaimRecoveries);
    this.requestDeadlineMs = positiveInteger('requestTimeoutMs', requestTimeoutMs) + positiveInteger('orphanGraceMs', orphanGraceMs);
    this.jobs = new Map();
    this.sourceFetches = [];
    this.parseRuns = [];
    this.pages = new Map();
    this.observations = new Map();
    this.observationHistory = [];
    this.unavailableCoverage = new Map();
    this.reconciliationIssues = [];
    this.operatorDispositions = [];
    this.runHalts = [];
    this.reconciliationDispositions = [];
    this.crawlScopes = [];
    this.nextIssueId = 1;
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
    const stored = newJobRecord(validated, now);
    this.jobs.set(validated.key, stored);
    return stored;
  }

  listJobs() { return [...this.jobs.values()].map(cloneJob); }
  getJob(key) {
    const job = this.jobs.get(key);
    return job ? cloneJob(job) : null;
  }

  // Like PostgreSQL's clock_timestamp(), this store's own clock is the only
  // authority for claims, lease expiry and retry readiness. The caller's time
  // argument is accepted for interface compatibility and ignored, so a skewed
  // worker clock cannot extend or cut short a lease.
  // pageTypes limits which jobs are claimed (a manifest run, #44); by default any.
  claimNextJob(_now, workerId, { pageTypes } = {}) {
    const now = this.clock();
    let current = this.#findClaimableJob(now, pageTypes);
    if (!current && this.recoverExpiredClaims() > 0) current = this.#findClaimableJob(now, pageTypes);
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

  // Jobs stopped by a halting code (a challenge) that no operator has reviewed
  // since: the job is still in operator_stop and no hold was recorded after its
  // latest stop. A release moves it out of operator_stop. Ordered by the job's
  // own history, not by clocks. Same contract as the PostgreSQL adapter's.
  unreviewedChallenges() {
    const pending = this.unreviewedRunHalts();
    for (const job of this.jobs.values()) {
      if (job.state !== 'operator_stop') continue;
      const stopIndex = job.history.findLastIndex((event) => event.to === 'operator_stop');
      if (stopIndex < 0 || !HALTING_STOP_CODES.includes(job.history[stopIndex].details?.code)) continue;
      if (job.history.slice(stopIndex + 1).some((entry) => entry.type === 'operator_disposition' && entry.disposition === 'hold')) continue;
      pending.push(deepFreeze({ jobKey: job.key, pageType: job.pageType, url: job.sourceUrl.absoluteUrl,
        code: job.history[stopIndex].details.code, stoppedAt: job.history[stopIndex].at }));
    }
    return pending;
  }

  // Halts of the whole run that no operator has released (#114): the raw disk is
  // full, requests keep failing across pages, the database is out of storage.
  // Same contract as the PostgreSQL adapter's.
  recordRunHalt({ reason, detail = null }) {
    if (!reason) throw new Error('a run halt needs a reason');
    const id = this.runHalts.length + 1;
    this.runHalts.push({ id, reason, detail, raisedAt: this.clock().toISOString(), releasedAt: null, releasedBy: null, releaseReason: null });
    return `halt-${id}`;
  }

  unreviewedRunHalts() {
    return this.runHalts.filter((halt) => !halt.releasedAt).map((halt) => deepFreeze({
      jobKey: null, pageType: null, url: null, code: halt.reason, detail: halt.detail, stoppedAt: halt.raisedAt, haltId: `halt-${halt.id}` }));
  }

  releaseRunHalt(haltId, { operatorId, reason }) {
    if (!operatorId || !reason?.trim()) throw new Error('releasing a halt requires operatorId and reason');
    const halt = this.runHalts.find((entry) => `halt-${entry.id}` === haltId);
    if (!halt) throw new Error(`halt ${haltId} does not exist`);
    if (halt.releasedAt) throw new Error(`halt ${haltId} is already released`);
    if (!this.authorizeOperator(operatorId, { kind: 'release_halt' })) throw new Error(`operator ${operatorId} is not authorized to review operator-stop work`);
    Object.assign(halt, { releasedAt: this.clock().toISOString(), releasedBy: operatorId, releaseReason: reason });
    return Object.freeze({ haltId, releasedBy: operatorId, reason });
  }

  // Jobs holding an unexpired claim by this store's clock: a worker is running
  // them now. The operator trigger refuses to start a second run while any do.
  liveClaimCount() {
    const now = this.clock();
    return [...this.jobs.values()].filter((job) => ['fetching', 'fetched'].includes(job.state) && job.claim
      && new Date(job.claim.expiresAt) > now).length;
  }

  // Job counts by state, without copying jobs or their history.
  jobCounts() {
    const counts = {};
    for (const job of this.jobs.values()) counts[job.state] = (counts[job.state] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
  }

  // Same rule as PostgresPersistence.workOutlook: runnable jobs that remain,
  // and how long until the earliest retry falls due or claim expires.
  workOutlook({ pageTypes } = {}) {
    const now = this.clock().getTime();
    const counted = (job) => !pageTypes || pageTypes.includes(job.pageType);
    const stopped = new Set(['operator_stop', 'parse_failed', 'permanently_failed']);
    const live = (job, depth = 0) => {
      const parent = job.parentKey ? this.jobs.get(job.parentKey) : null;
      if (!parent || depth > this.jobs.size) return true;
      return !stopped.has(parent.state) && live(parent, depth + 1);
    };
    let remaining = 0;
    let wakeAt = null;
    for (const job of this.jobs.values()) {
      if (!counted(job)) continue;
      if (['pending', 'retry_wait', 'fetching', 'fetched'].includes(job.state) && live(job)) remaining += 1;
      const due = job.state === 'retry_wait' ? job.nextAllowedAt : ['fetching', 'fetched'].includes(job.state) ? job.claim?.expiresAt : null;
      if (due) wakeAt = Math.min(wakeAt ?? Infinity, Date.parse(due));
    }
    return { remaining, wakeInMs: wakeAt == null ? null : Math.max(0, wakeAt - now) };
  }

  renewClaim(key, lease) {
    const job = this.#requireLease(key, lease);
    const now = this.clock();
    job.claim.expiresAt = new Date(now.getTime() + this.claimTimeoutMs).toISOString();
    job.updatedAt = now.toISOString();
  }

  // Cancels host requests whose worker died mid-request (see
  // DEFAULT_ORPHAN_GRACE_MS). A request is released only once both its start
  // and its owner's lease expiry are further in the past than the request
  // deadline, judged by this store's clock.
  releaseOrphanedRequests() {
    const now = this.clock();
    let released = 0;
    for (const [key, request] of [...this.inFlight]) {
      const job = this.jobs.get(key);
      const ownerExpiry = job?.claim && sameLease(job.claim.lease, request.lease) ? Date.parse(job.claim.expiresAt) : -Infinity;
      if (Math.max(Date.parse(request.startedAt), ownerExpiry) + this.requestDeadlineMs >= now.getTime()) continue;
      this.inFlight.delete(key);
      this.requestHistory.push(Object.freeze({ ...request, outcome: 'canceled', cancellationReason: ORPHANED_REQUEST_REASON, releasedAt: now.toISOString() }));
      released += 1;
    }
    return released;
  }

  recoverExpiredClaims() {
    this.releaseOrphanedRequests();
    const now = this.clock();
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (!job.claim || new Date(job.claim.expiresAt) > now || this.inFlight.has(job.key)) continue;
      if (job.state === 'fetching' || job.state === 'fetched') {
        const claimRecoveries = (job.claimRecoveries ?? 0) + 1;
        const exhausted = claimRecoveries >= this.maxClaimRecoveries;
        const previousError = job.lastError ?? null;
        job.claimRecoveries = claimRecoveries;
        if (exhausted) {
          job.nextAllowedAt = null;
          this.#applyTransition(job, 'permanently_failed', { lastError: `${CLAIM_EXPIRED}; claim recovery limit reached`, claimRecoveries, previousError }, now);
        } else {
          this.#applyTransition(job, 'retry_wait', { nextAllowedAt: now.toISOString(), lastError: CLAIM_EXPIRED, claimRecoveries }, now);
        }
        recovered += 1;
      } else {
        job.claim = null;
      }
    }
    return recovered;
  }

  getRequestSchedule(host, now = this.clock()) {
    const current = this.requestSchedules.get(host) ?? { lastStartedAt: null, starts: [], pausedUntil: null };
    const starts = current.starts.filter((at) => now.getTime() - at.getTime() < 60_000);
    return { lastStartedAt: current.lastStartedAt, starts: [...starts], pausedUntil: current.pausedUntil ?? null };
  }

  recordRequestStart(host, at) {
    const current = this.getRequestSchedule(host, at);
    current.starts.push(at);
    this.requestSchedules.set(host, { lastStartedAt: at, starts: current.starts, pausedUntil: current.pausedUntil });
  }

  // No request to the host may start before `until` (#113); a later pause is
  // never shortened by an earlier one. Same contract as the PostgreSQL adapter's.
  pauseHost(host, until) {
    const current = this.getRequestSchedule(host);
    const later = current.pausedUntil && current.pausedUntil.getTime() > until.getTime() ? current.pausedUntil : until;
    this.requestSchedules.set(host, { lastStartedAt: current.lastStartedAt, starts: current.starts, pausedUntil: later });
  }

  // Whether a request to the host may start now, and how long to wait if not
  // (#113, #118): a pause after a 429, or another request holding the host. An
  // orphaned request is released first, so a crashed worker's lock clears on its
  // own deadline. Same contract as the PostgreSQL adapter's.
  hostGate(host) {
    this.releaseOrphanedRequests();
    const now = this.clock();
    const { pausedUntil } = this.getRequestSchedule(host, now);
    if (pausedUntil && pausedUntil.getTime() > now.getTime()) return { waitMs: pausedUntil.getTime() - now.getTime(), reason: 'paused' };
    if ([...this.inFlight.values()].some((request) => request.host === host)) return { waitMs: HOST_BUSY_WAIT_MS, reason: 'in_flight' };
    return { waitMs: 0, reason: null };
  }

  // verification is the raw store's result for this body (from put or read);
  // see assertFetchVerification.
  recordFetch(metadata, lease, verification) {
    this.#requireLease(metadata.jobKey, lease);
    assertFetchVerification(metadata, verification);
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

  async repairRawObjects({ rawStore } = {}) {
    const report = await inventoryRawObjects({ rawStore, fetches: this.sourceFetches, observedAt: this.clock().toISOString() });
    for (const record of [...report.pending, ...report.orphans]) this.rawObjectRepairs.set(record.checksum, record);
    return report;
  }

  recordParse(run, lease) {
    this.#requireLease(run.jobKey, lease);
    return this.#appendParseRun(run);
  }

  #appendParseRun(run) {
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

  // Settled (parsed or parse_failed) jobs for offline reprocessing, keyset-paged
  // by job key. Same contract as PostgresPersistence#listJobsForReprocess.
  listJobsForReprocess({ pageTypes = PAGE_TYPES, states = REPROCESS_STATES, limit, cursor } = {}) {
    assertReprocessSelection(pageTypes, states);
    const entries = [...this.jobs.values()].filter((job) => states.includes(job.state) && pageTypes.includes(job.pageType))
      .map((job) => ({ key: [job.key], item: () => cloneJob(job) }));
    return memoryPage(entries, { limit, cursor }, ['string']);
  }

  // Records a reprocessing of a settled job's stored snapshot, and commits its
  // page when the parse was valid, in one step. A parse_failed job whose page
  // is accepted becomes parsed. No lease is involved: settled jobs are never
  // claimed. Same contract as PostgresPersistence#commitReprocess.
  commitReprocess({ jobKey, parseRun, page, provenance }) {
    const job = this.jobs.get(jobKey);
    if (!job || !REPROCESS_STATES.includes(job.state) || job.claim) {
      throw new Error(`reprocessing requires a parsed or parse_failed job. Current state: ${job?.state ?? 'missing'}`);
    }
    if (parseRun?.jobKey !== jobKey || !this.sourceFetches.some((fetch) => fetch.id === parseRun.sourceFetchId && fetch.jobKey === jobKey && fetch.checksum)) {
      throw new Error('reprocess source fetch does not belong to the job');
    }
    if (!page) return Object.freeze({ parseRunId: this.#appendParseRun(parseRun), committed: false });
    if (page.jobKey !== jobKey || provenance?.sourceFetchId !== parseRun.sourceFetchId) throw new Error('reprocessed page does not match its parse run');
    // A page whose refresh an operator asked for replaces the accepted record (#154).
    const staged = this.#stagePage(page, provenance, { accept: Boolean(job.refreshRequestedAt) });
    const transitioned = job.state === 'parse_failed' && !staged.conflict;
    if (transitioned) {
      const next = cloneJob(staged.jobs.get(jobKey));
      this.#applyTransition(next, 'parsed', { reprocessed: true, parserVersion: parseRun.parserVersion });
      delete next.refreshRequestedAt;
      staged.jobs.set(jobKey, next);
    }
    const parseRunId = this.#appendParseRun(parseRun);
    this.#installPage(staged);
    return Object.freeze({ parseRunId, committed: true, key: staged.key, conflict: staged.conflict, superseded: staged.superseded, transitioned });
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
    // A page whose refresh an operator asked for replaces the accepted record
    // instead of being held as a conflict, and the request is met once it is (#154).
    const staged = this.#stagePage(page, provenance, { accept: Boolean(this.jobs.get(page.jobKey)?.refreshRequestedAt) });
    const job = cloneJob(staged.jobs.get(page.jobKey));
    this.#applyTransition(job, 'parsed', {});
    delete job.refreshRequestedAt;
    staged.jobs.set(page.jobKey, job);
    this.#installPage(staged);
    return Object.freeze({ key: staged.key, conflict: staged.conflict, superseded: staged.superseded });
  }

  // accept (operator review, #48) commits a differing page as the accepted
  // record, as a supersede does.
  #stagePage(page, provenance, { accept = false } = {}) {
    const key = page.identity ?? page.jobKey;
    const record = Object.freeze({ ...page, provenance });
    const previous = this.pages.get(key);
    const differs = Boolean(previous && !jsonEqual(previous.data, record.data));
    // Same rule as PostgreSQL's writeNormalizedPage: a parser change over the
    // same raw body replaces the accepted record; any other difference is a
    // conflict held for review (PARSER_NORMALIZATION.md).
    const superseded = differs && (accept || this.#parserChangeOnly(previous.provenance, provenance));
    const conflict = differs && !superseded;
    const pages = new Map(this.pages);
    const observations = new Map(this.observations);
    // A superseding revision replaces the page's observations rather than
    // adding to them, so rows the new parser no longer emits disappear.
    if (superseded) {
      for (const [observationKey, observation] of observations) if (observation.parentKey === page.jobKey) observations.delete(observationKey);
    }
    const observationHistory = [...this.observationHistory];
    const unavailableCoverage = new Map(this.unavailableCoverage);
    const reconciliationIssues = [...this.reconciliationIssues];
    const jobs = new Map(this.jobs);
    // An open issue for the same accepted record and the same conflicting data
    // already covers a refetch; provenance alone does not make a new issue.
    const alreadyOpen = conflict && reconciliationIssues.some((issue) => issue.status === 'open'
      && issue.issueType === 'conflicting_page_reprocess' && issue.recordKey === key
      && jsonEqual(issue.details.previous.data, previous.data) && jsonEqual(issue.details.current.data, record.data));
    if (conflict && !alreadyOpen) {
      reconciliationIssues.push(createReconciliationIssue({
        id: `issue-${this.nextIssueId++}`,
        openedAt: this.clock().toISOString(),
        issueType: 'conflicting_page_reprocess',
        recordKey: key,
        details: {
          previous: { data: previous.data, provenance: previous.provenance },
          current: { data: record.data, provenance: record.provenance },
        },
        status: 'open',
      }));
    }
    if (!conflict) pages.set(key, record);
    for (const [index, observation] of (page.observations ?? []).entries()) {
      const observationKey = observation.key ?? `${observation.kind}:${observation.parentKey ?? page.jobKey}:${observation.rowIndex ?? observation.canonicalBoxScorePath ?? `row-${index}`}`;
      const storedObservation = Object.freeze({ ...observation, provenance });
      if (!observationHistory.some((entry) => jsonEqual(entry, storedObservation))) observationHistory.push(storedObservation);
      if (!conflict) observations.set(observationKey, storedObservation);
    }
    if (!conflict) {
      // A year the history now links is no longer unavailable (#154).
      if (page.kind === 'school_history') {
        const schoolSourcePath = this.jobs.get(page.jobKey)?.schoolSourcePath;
        for (const season of page.data.seasons ?? []) {
          if (season.url && Number.isInteger(season.endingYear)) unavailableCoverage.delete(`${schoolSourcePath}:${season.endingYear}`);
        }
      }
      for (const unavailable of page.unavailableCoverage ?? []) {
        const coverageKey = `${unavailable.schoolSourcePath}:${unavailable.endingYear}`;
        unavailableCoverage.set(coverageKey, Object.freeze({ ...unavailable, provenance }));
      }
      for (const child of page.childJobs ?? []) {
        const validated = createJob(child);
        if (jobs.has(validated.key)) continue;
        const now = this.clock().toISOString();
        jobs.set(validated.key, newJobRecord(validated, now));
      }
    }
    return { key, conflict, superseded, pages, observations, observationHistory, unavailableCoverage, reconciliationIssues, jobs };
  }

  // True when two provenances name the same raw body (by checksum) and
  // different parsers: the difference comes from the parser, not the source.
  #parserChangeOnly(previous, current) {
    const checksum = (sourceFetchId) => this.sourceFetches.find((fetch) => fetch.id === sourceFetchId)?.checksum;
    const before = checksum(previous?.sourceFetchId);
    return Boolean(before) && before === checksum(current?.sourceFetchId)
      && (previous.parserName !== current.parserName || previous.parserVersion !== current.parserVersion);
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

  // The id of the raw store this database's objects live in (#117), or null until
  // a worker records it. claimRawStoreId records it if none is recorded and
  // returns the id that is; same contract as the PostgreSQL adapter's.
  rawStoreId() { return this.recordedRawStoreId ?? null; }

  claimRawStoreId(storeId) {
    this.recordedRawStoreId ??= storeId;
    return this.recordedRawStoreId;
  }

  // The scope this store is crawled under (#78): the latest recorded, or the
  // full scope when none was. recordCrawlScope refuses one that does not cover
  // the latest; same contract as the PostgreSQL adapter's.
  crawlScope() { return this.crawlScopes.at(-1)?.scope ?? FULL_CRAWL_SCOPE; }

  recordCrawlScope(scope) {
    const previous = this.crawlScopes.at(-1)?.scope ?? null;
    const next = nextCrawlScope(previous, scope);
    if (next.changed) this.crawlScopes.push(Object.freeze({ scope: next.scope, recordedAt: this.clock().toISOString() }));
    return Object.freeze({ ...next, previous });
  }

  // Reconciliation reads (#46); same contracts as the PostgreSQL adapter's.
  // Every job, without history.
  reconciliationJobs() { return [...this.jobs.values()].map(reconciliationJob); }

  // The accepted record for each key that has one: { recordKey, jobKey, kind, data }.
  acceptedPages(recordKeys) {
    return recordKeys.flatMap((recordKey) => {
      const page = this.pages.get(recordKey);
      return page ? [deepFreeze({ recordKey, jobKey: page.jobKey, kind: page.kind, data: page.data })] : [];
    });
  }

  // The accepted observations the given pages emitted: { key, observation }.
  acceptedObservations(jobKeys) {
    const parents = new Set(jobKeys);
    return [...this.observations].filter(([, observation]) => parents.has(observation.parentKey))
      .map(([key, { provenance, ...observation }]) => deepFreeze({ key, observation }));
  }

  coverageGaps() {
    return [...this.unavailableCoverage.values()].map(({ schoolSourcePath, endingYear }) => deepFreeze({ schoolSourcePath, endingYear }));
  }

  // Jobs with a structural failure and no valid parse run at all.
  failedParses() {
    const valid = new Set(this.parseRuns.filter((run) => run.status === 'valid').map((run) => run.jobKey));
    return [...new Set(this.parseRuns.filter((run) => run.status === 'structural_failure' && !valid.has(run.jobKey)).map((run) => run.jobKey))]
      .map((jobKey) => deepFreeze({ jobKey }));
  }

  openIssues() {
    return this.reconciliationIssues.filter((issue) => issue.status === 'open')
      .map((issue) => deepFreeze({ id: issue.id ?? null, recordKey: issue.recordKey, issueType: issue.issueType }));
  }

  rejectedUrls() {
    return [...this.observations].filter(([, observation]) => observation.kind === 'rejected_url')
      .map(([key, observation]) => deepFreeze({ key, absoluteUrl: observation.absoluteUrl, reason: observation.reason }));
  }

  // Operator review (#48); same contracts as the PostgreSQL adapter's methods.
  reviewJobs({ states = REVIEW_JOB_STATES, limit, cursor } = {}) {
    assertReviewStates(states);
    const entries = [...this.jobs.values()].filter((job) => states.includes(job.state))
      .map((job) => ({ key: [job.key], item: () => this.#reviewItem(job) }));
    return memoryPage(entries, { limit, cursor }, ['string']);
  }

  reviewJob(key) {
    const job = this.jobs.get(key);
    return job ? this.#reviewItem(job) : null;
  }

  #reviewItem(job) {
    const run = this.parseRuns.findLast((entry) => entry.jobKey === job.key);
    const fetch = this.lastSuccessfulFetch(job.key);
    return deepFreeze({
      ...reviewJobSummary(job),
      lastParseRun: run ? { id: run.id, parserName: run.parserName, parserVersion: run.parserVersion, status: run.status,
        warnings: run.warnings, failureDetails: run.failureDetails, parsedAt: run.parsedAt } : null,
      snapshot: fetch ? { sourceFetchId: fetch.id, status: fetch.status, checksum: fetch.checksum, objectPath: fetch.objectPath,
        fetchedAt: fetch.fetchedAt, cacheHit: fetch.cacheHit } : null,
      dispositions: this.operatorDispositions.filter((entry) => entry.jobKey === job.key)
        .map(({ kind, operatorId, reason, at }) => ({ kind, operatorId, reason, at })),
    });
  }

  reviewIssues({ status = 'open', issueTypes, limit, cursor } = {}) {
    const entries = this.reconciliationIssues.filter((issue) => issue.id && issue.status === status && (!issueTypes || issueTypes.includes(issue.issueType)))
      .map((issue) => ({ key: [Number(issue.id.slice('issue-'.length))], item: () => memoryIssue(issue) }));
    return memoryPage(entries, { limit, cursor }, ['integer']);
  }

  getIssue(issueId) {
    const issue = this.reconciliationIssues.find((entry) => entry.id === issueId);
    if (!issue) return null;
    let quarantinedRevision = null;
    let acceptedRevision = null;
    if (issue.issueType === 'conflicting_page_reprocess') {
      const current = issue.details.current.provenance;
      quarantinedRevision = { id: null, sourceFetchId: current.sourceFetchId, parserName: current.parserName, parserVersion: current.parserVersion,
        jobKey: this.sourceFetches.find((fetch) => fetch.id === current.sourceFetchId)?.jobKey ?? null };
      const accepted = this.pages.get(issue.recordKey)?.provenance;
      acceptedRevision = accepted ? { id: null, sourceFetchId: accepted.sourceFetchId, parserName: accepted.parserName, parserVersion: accepted.parserVersion } : null;
    }
    return deepFreeze({ ...memoryIssue(issue), quarantinedRevision, acceptedRevision,
      dispositions: this.reconciliationDispositions.filter((entry) => entry.issueId === issueId)
        .map(({ kind, operatorId, reason, at, revisionId }) => ({ kind, operatorId, reason, at, revisionId })) });
  }

  getSourceFetch(sourceFetchId) {
    const fetch = this.sourceFetches.find((entry) => entry.id === sourceFetchId);
    return fetch ? deepFreeze({ id: fetch.id, jobKey: fetch.jobKey, status: fetch.status, checksum: fetch.checksum,
      objectPath: fetch.objectPath, fetchedAt: fetch.fetchedAt, cacheHit: fetch.cacheHit }) : null;
  }

  acceptRevision({ issueId, page, provenance, operatorId, reason, at = this.clock() }) {
    const disposition = createReviewDisposition('accept', operatorId, reason, at);
    if (!this.authorizeOperator(disposition.operatorId, disposition)) throw new Error(`operator ${disposition.operatorId} is not authorized to review quarantined records`);
    const issue = this.#openIssue(issueId, 'conflicting_page_reprocess');
    if (page.identity !== issue.recordKey) throw new Error('the page is not the record this issue holds');
    if (!jsonEqual(page.data, issue.details.current.data)) throw new Error('the page does not match the revision this issue holds');
    if (!jsonEqual(this.pages.get(issue.recordKey)?.data, issue.details.previous.data)) {
      throw new Error('the accepted record changed since this issue opened; dismiss it and review the current record');
    }
    const job = this.jobs.get(page.jobKey);
    if (!job || !REPROCESS_STATES.includes(job.state) || job.claim) throw new Error(`accepting a revision requires its job to be parsed. Current state: ${job?.state ?? 'missing'}`);
    const staged = this.#stagePage(page, provenance, { accept: true });
    staged.reconciliationIssues = staged.reconciliationIssues.map((entry) => (entry === issue ? Object.freeze({ ...entry, status: 'accepted' }) : entry));
    this.#installPage(staged);
    const record = Object.freeze({ issueId, key: staged.key, revisionId: null, ...disposition });
    this.reconciliationDispositions.push(record);
    return record;
  }

  dismissIssue({ issueId, operatorId, reason, at = this.clock() }) {
    const disposition = createReviewDisposition('dismiss', operatorId, reason, at);
    if (!this.authorizeOperator(disposition.operatorId, disposition)) throw new Error(`operator ${disposition.operatorId} is not authorized to review quarantined records`);
    const issue = this.#openIssue(issueId);
    this.reconciliationIssues = this.reconciliationIssues.map((entry) => (entry === issue ? Object.freeze({ ...entry, status: 'resolved' }) : entry));
    const record = Object.freeze({ issueId, revisionId: null, ...disposition });
    this.reconciliationDispositions.push(record);
    return record;
  }

  #openIssue(issueId, issueType) {
    const issue = this.reconciliationIssues.find((entry) => entry.id === issueId);
    if (!issue) throw new Error(`issue ${issueId} does not exist`);
    if (issue.status !== 'open') throw new Error(`issue ${issueId} is already ${issue.status}`);
    if (issueType && issue.issueType !== issueType) throw new Error(`only a ${issueType} issue can be accepted; dismiss a ${issue.issueType} issue instead`);
    return issue;
  }

  // Puts parsed school index and history pages back in the queue for their
  // season rollover refresh (#154), all or none: each gets one recorded refresh
  // disposition, a fresh budget of every kind, and a refresh request that lets
  // its next parse replace the accepted record. Same contract as
  // PostgresPersistence#requestRefresh.
  requestRefresh({ keys, operatorId, reason, at = this.clock() }) {
    const validated = createOperatorDisposition('refresh', operatorId, reason, new Date(at));
    if (!this.authorizeOperator(validated.operatorId, validated)) {
      throw new Error(`operator ${validated.operatorId} is not authorized to review operator-stop work`);
    }
    const unique = [...new Set(keys)];
    for (const key of unique) {
      const job = this.jobs.get(key);
      if (!job || job.state !== 'parsed' || !REFRESH_PAGE_TYPES.includes(job.pageType)) {
        throw new Error(`refresh needs a parsed ${REFRESH_PAGE_TYPES.join(' or ')} job. ${key} is ${job ? `${job.pageType} in state ${job.state}` : 'missing'}`);
      }
    }
    for (const key of unique) {
      const job = this.jobs.get(key);
      this.operatorDispositions.push(Object.freeze({ jobKey: key, ...validated }));
      job.history.push(Object.freeze({ type: 'operator_disposition', state: job.state, at: validated.at, operatorId: validated.operatorId, disposition: validated.kind, reason: validated.reason }));
      job.failureAttempts = 0;
      job.rateLimitAttempts = 0;
      job.claimRecoveries = 0;
      job.refreshRequestedAt = validated.at;
      this.#applyTransition(job, 'retry_wait', { nextAllowedAt: validated.at, lastError: `refresh requested: ${validated.reason}` });
    }
    return Object.freeze({ requested: unique.length });
  }

  recordOperatorDisposition(key, disposition) {
    if (disposition.kind === 'refresh') throw new Error('a refresh is recorded with requestRefresh, for a set of parsed pages');
    const job = this.jobs.get(key);
    const needed = disposition.kind === 'requeue_failed' ? 'permanently_failed' : 'operator_stop';
    if (!job || job.state !== needed) throw new Error(`operator disposition ${disposition.kind} requires ${needed}. Current state: ${job?.state ?? 'missing'}`);
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
    // A reviewed release gives the job a fresh 429 budget; the transport/5xx
    // budget is kept.
    if (validated.kind === 'release_retry') job.rateLimitAttempts = 0;
    if (validated.kind === 'release_retry') this.#applyTransition(job, 'retry_wait', { nextAllowedAt: this.clock().toISOString(), lastError: validated.reason });
    if (validated.kind === 'release_permanent') this.#applyTransition(job, 'permanently_failed', { failureReason: validated.reason });
    // Requeue gives the page a fresh budget of every kind (#114).
    if (validated.kind === 'requeue_failed') {
      job.failureAttempts = 0;
      job.rateLimitAttempts = 0;
      job.claimRecoveries = 0;
      this.#applyTransition(job, 'retry_wait', { nextAllowedAt: this.clock().toISOString(), lastError: validated.reason });
    }
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

  // Read port for the query service, with the same keyset paging contract as
  // the PostgreSQL adapter (see BOUNDARY_CONTRACTS.md).
  listSchools(request) {
    const entries = [];
    for (const page of this.pages.values()) {
      if (page.kind !== 'school_index') continue;
      for (const [rowIndex, school] of (page.data.schools ?? []).entries()) {
        entries.push({ key: [page.identity, school.path], item: () => this.#schoolModel(page, school, rowIndex) });
      }
    }
    return memoryPage(entries, request, ['string', 'string']);
  }

  listSeasons(request) {
    const entries = [...this.pages.values()].filter((page) => page.kind === 'season')
      .map((page) => ({ key: [page.identity], item: () => ({ ...page.data, provenance: page.provenance }) }));
    return memoryPage(entries, request, ['string']);
  }

  listGames(request) {
    const entries = [...this.pages.values()].filter((page) => page.kind === 'game')
      .map((page) => ({ key: [page.identity], item: () => gameModel(page) }));
    return memoryPage(entries, request, ['string']);
  }

  getGame(key) {
    const page = typeof key === 'string' ? this.pages.get(key) : undefined;
    return page?.kind === 'game' ? deepFreeze(gameModel(page)) : null;
  }

  health() {
    const jobStates = {};
    for (const job of this.jobs.values()) jobStates[job.state] = (jobStates[job.state] ?? 0) + 1;
    return deepFreeze({
      jobStates,
      sourceFetches: this.sourceFetches.length,
      parseRuns: this.parseRuns.length,
      warnings: this.parseRuns.reduce((total, run) => total + (run.warnings?.length ?? 0), 0),
      unavailableCoverage: this.unavailableCoverage.size,
      conflicts: this.reconciliationIssues.filter((issue) => issue.status === 'open').length,
      observations: this.observations.size,
    });
  }

  // Same shape as PostgresPersistence#crawlStatus, for `cli.mjs status`.
  crawlStatus({ windowMs = 3_600_000 } = {}) {
    const now = this.clock();
    const scope = this.crawlScope();
    const counts = new Map();
    for (const job of this.jobs.values()) {
      const key = `${job.pageType}|${job.state}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const network = this.sourceFetches.filter((fetch) => !fetch.cacheHit).map((fetch) => new Date(fetch.fetchedAt).getTime());
    return deepFreeze({
      observedAt: now.toISOString(),
      scope,
      jobs: [...counts].map(([key, count]) => { const [pageType, state] = key.split('|'); return { pageType, state, count }; }),
      fetches: {
        total: network.length,
        inWindow: network.filter((at) => at > now.getTime() - windowMs).length,
        windowMs,
        firstAt: network.length ? new Date(Math.min(...network)).toISOString() : null,
        lastAt: network.length ? new Date(Math.max(...network)).toISOString() : null,
      },
    });
  }

  #schoolModel(page, school, rowIndex) {
    const observation = this.observations.get(`school:${page.jobKey}:${rowIndex}`);
    if (typeof observation?.eligible !== 'boolean') {
      throw new Error(`school eligibility observation is missing for ${page.jobKey} row ${rowIndex}`);
    }
    return { ...school, eligible: observation.eligible, provenance: page.provenance };
  }

  #findClaimableJob(now, pageTypes) {
    for (const job of this.jobs.values()) {
      if (pageTypes && !pageTypes.includes(job.pageType)) continue;
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
    const { charge, ...fields } = details;
    Object.assign(job, fields);
    // charge names the retry budget this transition spends (see chargedRetry
    // and rateLimitedRetry in contracts/request-policy.mjs).
    if (charge === 'failure') job.failureAttempts = (job.failureAttempts ?? 0) + 1;
    if (charge === 'rate_limit') job.rateLimitAttempts = (job.rateLimitAttempts ?? 0) + 1;
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
