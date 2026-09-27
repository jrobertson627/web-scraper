import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  DEFAULT_MAX_CLAIM_RECOVERIES, assertTransition, createLeaseToken, createOperatorDisposition, positiveInteger,
} from '../contracts/jobs.mjs';
import {
  createJob, createPageRequest, createQueryModels, createReadPage, decodePageCursor, deepFreeze,
} from '../contracts/boundaries.mjs';
import { canonicalPathString, createSourceUrl, sourceKey } from '../contracts/source.mjs';
import { writeNormalizedPage } from './postgres-domain.mjs';
// Server-side cap on any one statement, so a stuck query fails its transaction
// instead of holding a lease or a pool client indefinitely.
import { DEFAULT_STATEMENT_TIMEOUT_MS } from '../config/persistence.mjs';

const { Pool } = pg;
const CHECKSUM = /^[0-9a-f]{64}$/;
const FINAL_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);
const FAILURE_STATES = new Set(['retry_wait', 'operator_stop', 'parse_failed', 'permanently_failed']);
const CLAIM_EXPIRED = 'claim expired before completion';

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
// A job key is `${providerId}:${canonicalPath}:${pageType}`. Provider ids never
// contain ':' (createJob rejects them) and page types are fixed words, so a key
// splits back into the three columns of UNIQUE (provider_id, canonical_path,
// page_type) and every lookup is served by that index. A malformed key splits
// into NULLs, which match no row.
export function jobKeyParts(key) {
  const text = typeof key === 'string' ? key : '';
  const first = text.indexOf(':');
  const last = text.lastIndexOf(':');
  if (first < 1 || last <= first + 1 || last === text.length - 1) return [null, null, null];
  return [text.slice(0, first), text.slice(first + 1, last), text.slice(last + 1)];
}
function byKey(from, alias = '') {
  return `${alias}provider_id = $${from} AND ${alias}canonical_path = $${from + 1} AND ${alias}page_type = $${from + 2}`;
}
function dbPath(canonicalPath) { return canonicalPathString(canonicalPath); }
function canonicalFromRow(row) {
  const url = new URL(`https://${row.canonical_path}`);
  return { providerId: row.provider_id, host: url.host, path: url.pathname, normalizedQuery: url.search.slice(1) };
}
function portId(prefix, id) { return `${prefix}-${id}`; }
function sqlId(prefix, value) {
  const match = new RegExp(`^${prefix}-([1-9]\\d*)$`).exec(String(value));
  if (!match) throw new Error(`invalid ${prefix} id`);
  return match[1];
}
function mapJob(row, events = []) {
  const canonicalPath = canonicalFromRow(row);
  const lease = row.claim_owner && row.lease_generation != null
    ? createLeaseToken(row.claim_owner, Number(row.lease_generation)) : null;
  const history = events.map((event) => ({
    from: event.from_state, to: event.to_state, at: iso(event.transitioned_at),
    attempts: event.attempts, leaseGeneration: event.lease_generation == null ? null : Number(event.lease_generation),
    details: event.details,
  }));
  return {
    key: sourceKey(canonicalPath, row.page_type),
    pageType: row.page_type,
    sourceUrl: createSourceUrl(row.provider_id, row.source_url),
    canonicalPath,
    parentKey: row.parent_key ?? undefined,
    schoolSourcePath: row.school_source_path ?? undefined,
    parserVersion: row.parser_version,
    state: row.state,
    attempts: row.attempts,
    claimRecoveries: row.claim_recoveries ?? 0,
    generation: Number(row.claim_generation),
    nextAllowedAt: iso(row.next_allowed_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    claim: lease ? { owner: row.claim_owner, expiresAt: iso(row.claim_expires_at), lease } : null,
    history,
    failures: history.filter((event) => FAILURE_STATES.has(event.to)).map((event) => ({
      state: event.to, at: event.at, attempts: event.attempts,
      reason: event.details.lastError ?? event.details.failureReason ?? 'unspecified failure', details: event.details,
    })),
    lease,
  };
}

const guardedPools = new WeakSet();

function logPoolError(error) {
  console.error(JSON.stringify({ event: 'postgres.pool_error', code: error?.code ?? 'unknown', at: new Date().toISOString() }));
}

// An idle pooled client that loses its connection (for example a database
// restart) is emitted as a pool 'error'; with no listener Node would crash the
// process. Log the error code only, since a driver message can name the host or
// user, and let the pool replace the client on the next checkout.
export function guardPool(pool, onError = logPoolError) {
  if (!pool || typeof pool.on !== 'function' || guardedPools.has(pool)) return pool;
  guardedPools.add(pool);
  pool.on('error', (error) => {
    try { onError(error); } catch { /* a failing logger must not crash the process either */ }
  });
  return pool;
}

export class PostgresPersistence {
  constructor({ pool = new Pool({ statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS }), claimTimeoutMs = 30_000,
    authorizeOperator = (id) => Boolean(id), onPoolError,
    maxClaimRecoveries = DEFAULT_MAX_CLAIM_RECOVERIES } = {}) {
    if (!Number.isInteger(claimTimeoutMs) || claimTimeoutMs < 1) throw new Error('claimTimeoutMs must be positive');
    this.pool = guardPool(pool, onPoolError);
    this.claimTimeoutMs = claimTimeoutMs;
    this.authorizeOperator = authorizeOperator;
    this.maxClaimRecoveries = positiveInteger('maxClaimRecoveries', maxClaimRecoveries);
  }

  async close() { await this.pool.end(); }

  async transaction(action) {
    const client = await this.pool.connect();
    // A client whose ROLLBACK failed may still be inside the aborted
    // transaction, so it is destroyed rather than returned to the pool.
    let broken;
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; /* preserve the original error */ }
      throw error;
    } finally { client.release(broken); }
  }

  async addJob(job) {
    const validated = createJob(job);
    return this.transaction(async (client) => {
      let parentId = null;
      if (validated.parentKey) {
        const parent = await client.query(`SELECT id FROM crawl_jobs WHERE ${byKey(1)}`, jobKeyParts(validated.parentKey));
        if (!parent.rowCount) throw new Error(`parent job is missing: ${validated.parentKey}`);
        parentId = parent.rows[0].id;
      }
      const inserted = await client.query(`
        INSERT INTO crawl_jobs (provider_id, canonical_path, page_type, source_url, parent_job_id, school_source_path, parser_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (provider_id, canonical_path, page_type) DO NOTHING
        RETURNING *`, [validated.sourceUrl.providerId, dbPath(validated.canonicalPath), validated.pageType,
        validated.sourceUrl.absoluteUrl, parentId, validated.schoolSourcePath ?? null, validated.parserVersion ?? '1']);
      const row = inserted.rows[0] ?? (await client.query(`SELECT * FROM crawl_jobs WHERE ${byKey(1)}`,
        [validated.sourceUrl.providerId, dbPath(validated.canonicalPath), validated.pageType])).rows[0];
      return mapJob(row);
    });
  }

  async listJobs() {
    const jobs = await this.pool.query(`SELECT j.*, p.provider_id || ':' || p.canonical_path || ':' || p.page_type AS parent_key
      FROM crawl_jobs j LEFT JOIN crawl_jobs p ON p.id = j.parent_job_id ORDER BY j.created_at, j.id`);
    if (!jobs.rowCount) return [];
    const events = await this.pool.query('SELECT * FROM job_state_events WHERE job_id = ANY($1::bigint[]) ORDER BY id', [jobs.rows.map((row) => row.id)]);
    return jobs.rows.map((row) => mapJob(row, events.rows.filter((event) => event.job_id === row.id)));
  }

  async getJob(key) {
    const result = await this.pool.query(`SELECT j.*, p.provider_id || ':' || p.canonical_path || ':' || p.page_type AS parent_key
      FROM crawl_jobs j LEFT JOIN crawl_jobs p ON p.id = j.parent_job_id WHERE ${byKey(1, 'j.')}`, jobKeyParts(key));
    if (!result.rowCount) return null;
    const events = await this.pool.query('SELECT * FROM job_state_events WHERE job_id = $1 ORDER BY id', [result.rows[0].id]);
    return mapJob(result.rows[0], events.rows);
  }

  async claimNextJob(_now, workerId) {
    if (!workerId) throw new Error('workerId is required');
    await this.recoverExpiredClaims();
    return this.transaction(async (client) => {
      const selected = await client.query(`SELECT j.* FROM crawl_jobs j
        WHERE (j.state = 'pending' OR (j.state = 'retry_wait' AND j.next_allowed_at <= clock_timestamp()))
          AND (j.parent_job_id IS NULL OR EXISTS
            (SELECT 1 FROM crawl_jobs p WHERE p.id = j.parent_job_id AND p.state = 'parsed'))
        ORDER BY j.created_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      if (!selected.rowCount) return null;
      const row = selected.rows[0];
      const claimed = await client.query(`UPDATE crawl_jobs SET state = 'fetching', attempts = attempts + 1,
        claim_generation = claim_generation + 1, lease_generation = claim_generation + 1,
        claim_owner = $2, claim_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
        next_allowed_at = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [row.id, workerId, this.claimTimeoutMs]);
      const current = claimed.rows[0];
      await this.recordEvent(client, current, row.state, 'fetching', { owner: workerId });
      return mapJob(current);
    });
  }

  async renewClaim(key, lease) {
    const result = await this.pool.query(`UPDATE crawl_jobs SET claim_expires_at = clock_timestamp() + ($6::bigint * interval '1 millisecond'),
      updated_at = clock_timestamp() WHERE ${byKey(1)} AND claim_owner = $4 AND lease_generation = $5
      AND claim_expires_at > clock_timestamp() AND state IN ('fetching','fetched')`,
    [...jobKeyParts(key), lease?.workerId, lease?.generation, this.claimTimeoutMs]);
    if (!result.rowCount) throw new Error(`stale or missing lease for job ${key}`);
  }

  async recoverExpiredClaims() {
    return this.transaction(async (client) => {
      const expired = await client.query(`SELECT j.* FROM crawl_jobs j
        WHERE j.state IN ('fetching','fetched') AND j.claim_expires_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM in_flight_requests r WHERE r.job_id = j.id AND r.released_at IS NULL)
        FOR UPDATE OF j SKIP LOCKED`);
      for (const row of expired.rows) {
        const exhausted = row.claim_recoveries + 1 >= this.maxClaimRecoveries;
        const lastError = exhausted ? `${CLAIM_EXPIRED}; claim recovery limit reached` : CLAIM_EXPIRED;
        const updated = await client.query(`UPDATE crawl_jobs SET state = $2,
          next_allowed_at = CASE WHEN $3 THEN NULL ELSE clock_timestamp() END, claim_recoveries = claim_recoveries + 1,
          last_error = $4, claim_owner = NULL, claim_expires_at = NULL,
          lease_generation = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING next_allowed_at, claim_recoveries`,
        [row.id, exhausted ? 'permanently_failed' : 'retry_wait', exhausted, lastError]);
        const { next_allowed_at: nextAllowedAt, claim_recoveries: claimRecoveries } = updated.rows[0];
        await this.recordEvent(client, row, row.state, exhausted ? 'permanently_failed' : 'retry_wait', exhausted
          ? { lastError, claimRecoveries, previousError: row.last_error }
          : { nextAllowedAt: iso(nextAllowedAt), lastError, claimRecoveries });
      }
      return expired.rowCount;
    });
  }

  // The database clock is the only authority for lease validity (see "Time
  // authority for leases" in JOB_LIFECYCLE.md), so the whole check runs in SQL.
  async leasedJob(client, key, lease) {
    const result = await client.query(`SELECT * FROM crawl_jobs WHERE ${byKey(1)} AND claim_owner = $4
      AND lease_generation = $5 AND claim_expires_at > clock_timestamp() FOR UPDATE`,
    [...jobKeyParts(key), lease?.workerId ?? null, lease?.generation ?? null]);
    if (!result.rowCount) throw new Error(`stale or missing lease for job ${key}`);
    return result.rows[0];
  }

  async recordEvent(client, row, from, to, details) {
    await client.query(`INSERT INTO job_state_events (job_id, from_state, to_state, attempts, lease_generation, details, transitioned_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp())`,
    [row.id, from, to, row.attempts, row.lease_generation, JSON.stringify(details)]);
  }

  async transition(client, row, nextState, details = {}) {
    assertTransition(row.state, nextState);
    const active = await client.query('SELECT 1 FROM in_flight_requests WHERE job_id = $1 AND released_at IS NULL', [row.id]);
    if (active.rowCount) throw new Error(`cannot transition job while its host request is still active`);
    const clear = FINAL_STATES.has(nextState);
    const next = await client.query(`UPDATE crawl_jobs SET state = $2, next_allowed_at = $3,
      last_error = COALESCE($4,last_error), claim_owner = CASE WHEN $5 THEN NULL ELSE claim_owner END,
      claim_expires_at = CASE WHEN $5 THEN NULL ELSE claim_expires_at END,
      lease_generation = CASE WHEN $5 THEN NULL ELSE lease_generation END,
      updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
    [row.id, nextState, details.nextAllowedAt ?? null, details.lastError ?? details.failureReason ?? null, clear]);
    await this.recordEvent(client, row, row.state, nextState, details);
    return next.rows[0];
  }

  async transitionJob(key, nextState, lease, details = {}) {
    return this.transaction(async (client) => {
      const row = await this.leasedJob(client, key, lease);
      return this.transition(client, row, nextState, details);
    });
  }

  async getRequestSchedule(host) {
    const result = await this.pool.query('SELECT last_request_started_at, recent_request_starts FROM host_request_schedule WHERE host = $1', [host]);
    return { lastStartedAt: result.rows[0]?.last_request_started_at ?? null,
      starts: (result.rows[0]?.recent_request_starts ?? []).map((value) => new Date(value)) };
  }

  async recordRequestStart(host, at = new Date()) {
    await this.pool.query(`INSERT INTO host_request_schedule (host, last_request_started_at, recent_request_starts)
      VALUES ($1,$2,ARRAY[$2::timestamptz])
      ON CONFLICT (host) DO UPDATE SET last_request_started_at = $2,
        recent_request_starts = (SELECT array_agg(t) FROM unnest(host_request_schedule.recent_request_starts || $2::timestamptz) t
          WHERE t > $2::timestamptz - interval '1 minute')`, [host, at]);
  }

  async acquireRequest(key, lease, host) {
    return this.transaction(async (client) => {
      const row = await this.leasedJob(client, key, lease);
      const request = await client.query(`INSERT INTO in_flight_requests
          (request_id,job_id,provider_id,host,lease_generation,started_at)
          VALUES ($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING *`,
        [randomUUID(), row.id, row.provider_id, host, lease.generation]);
      if (!request.rowCount) return null;
      return { id: request.rows[0].request_id, jobKey: key, host, lease, startedAt: iso(request.rows[0].started_at) };
    });
  }

  async releaseRequest(key, lease) {
    const result = await this.pool.query(`UPDATE in_flight_requests SET released_at = clock_timestamp(), outcome = 'completed'
      WHERE job_id = (SELECT id FROM crawl_jobs WHERE ${byKey(3)} AND claim_owner = $2
        AND lease_generation = $1)
        AND lease_generation = $1 AND released_at IS NULL`, [lease?.generation, lease?.workerId, ...jobKeyParts(key)]);
    if (result.rowCount !== 1) throw new Error('request ownership mismatch');
  }

  async confirmRequestCancellation(key, lease, reason) {
    if (!reason) throw new Error('request cancellation confirmation requires a reason');
    const result = await this.pool.query(`UPDATE in_flight_requests SET released_at = clock_timestamp(), outcome = 'canceled',
      cancellation_reason = $3 WHERE job_id = (SELECT id FROM crawl_jobs WHERE ${byKey(4)}
      AND claim_owner = $2 AND lease_generation = $1)
      AND lease_generation = $1 AND released_at IS NULL RETURNING *`, [lease?.generation, lease?.workerId, reason, ...jobKeyParts(key)]);
    if (result.rowCount !== 1) throw new Error('request cancellation requires the current request ownership token');
    return result.rows[0];
  }

  async recordFetch(metadata, lease, rawStore) {
    const successful = (metadata.status >= 200 && metadata.status < 300) || metadata.status === 304;
    if (successful && (!CHECKSUM.test(metadata.checksum ?? '') || !metadata.objectPath)) throw new Error('successful fetch requires a valid checksum and raw object path');
    if (rawStore) {
      const verified = rawStore.verify(metadata.checksum, metadata.objectPath);
      if (!verified.ok) throw new Error(`raw fetch metadata rejected before durable record: ${verified.reason}`);
    }
    return this.transaction(async (client) => {
      const job = await this.leasedJob(client, metadata.jobKey, lease);
      const record = await client.query(`INSERT INTO source_fetches
        (job_id,provider_id,canonical_path,http_status,fetched_at,etag,last_modified,checksum,raw_object_path,reused_body,cache_control,cache_hit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [job.id, job.provider_id, job.canonical_path, metadata.status, metadata.fetchedAt ?? new Date(),
        metadata.etag ?? null, metadata.lastModified ?? null, metadata.checksum ?? null,
        metadata.objectPath ?? null, metadata.reusedBody ?? false,
        metadata.cacheControl ?? null, metadata.cacheHit ?? false]);
      return portId('fetch', record.rows[0].id);
    });
  }

  async lastSuccessfulFetch(jobKey) {
    const result = await this.pool.query(`SELECT f.* FROM source_fetches f JOIN crawl_jobs j ON j.id = f.job_id
      WHERE ${byKey(1, 'j.')} AND f.checksum IS NOT NULL
      ORDER BY f.fetched_at DESC, f.id DESC LIMIT 1`, jobKeyParts(jobKey));
    const row = result.rows[0];
    return row ? { id: portId('fetch', row.id), jobKey, status: row.http_status, checksum: row.checksum,
      objectPath: row.raw_object_path, etag: row.etag, lastModified: row.last_modified,
      cacheControl: row.cache_control, cacheHit: row.cache_hit, fetchedAt: iso(row.fetched_at) } : null;
  }

  async recordParse(run, lease) {
    return this.transaction(async (client) => {
      const job = await this.leasedJob(client, run.jobKey, lease);
      const result = await client.query(`INSERT INTO parse_runs
        (job_id,source_fetch_id,parser_name,parser_version,status,warnings,failure_details,parsed_at)
        SELECT $1,f.id,$3,$4,$5,$6::jsonb,$7::jsonb,$8 FROM source_fetches f
        WHERE f.id = $2 AND f.job_id = $1 RETURNING id`,
      [job.id, sqlId('fetch', run.sourceFetchId), run.parserName, run.parserVersion, run.status,
        JSON.stringify(run.warnings ?? []), JSON.stringify(run.failureDetails ?? null), run.parsedAt ?? new Date()]);
      if (!result.rowCount) throw new Error('parse source fetch does not belong to the leased job');
      return portId('parse', result.rows[0].id);
    });
  }

  async commitPage(page, provenance, lease) {
    return this.transaction(async (client) => {
      const job = await this.leasedJob(client, page.jobKey, lease);
      return writeNormalizedPage(client, job, page, provenance, sqlId('fetch', provenance.sourceFetchId));
    });
  }

  async commitPageAndTransition(page, provenance, lease) {
    return this.transaction(async (client) => {
      const job = await this.leasedJob(client, page.jobKey, lease);
      const result = await writeNormalizedPage(client, job, page, provenance, sqlId('fetch', provenance.sourceFetchId));
      await this.transition(client, job, 'parsed');
      return result;
    });
  }

  async recordOperatorDisposition(key, disposition) {
    const validated = createOperatorDisposition(disposition.kind, disposition.operatorId, disposition.reason,
      disposition.at ? new Date(disposition.at) : new Date());
    if (!this.authorizeOperator(validated.operatorId, validated)) throw new Error('operator is not authorized to review operator-stop work');
    return this.transaction(async (client) => {
      const found = await client.query(`SELECT * FROM crawl_jobs WHERE ${byKey(1)} FOR UPDATE`, jobKeyParts(key));
      const job = found.rows[0];
      if (!job || job.state !== 'operator_stop') throw new Error('operator disposition requires operator_stop');
      await client.query(`INSERT INTO operator_dispositions (job_id,disposition,operator_id,reason,recorded_at)
        VALUES ($1,$2,$3,$4,$5)`, [job.id, validated.kind, validated.operatorId, validated.reason, validated.at]);
      if (validated.kind === 'release_retry') await this.transition(client, job, 'retry_wait', {
        nextAllowedAt: validated.at, lastError: validated.reason, operatorId: validated.operatorId,
      });
      if (validated.kind === 'release_permanent') await this.transition(client, job, 'permanently_failed', {
        failureReason: validated.reason, operatorId: validated.operatorId,
      });
      return validated;
    });
  }

  async repairRawObjects({ rawStore } = {}) {
    if (!rawStore || typeof rawStore.entries !== 'function' || typeof rawStore.verify !== 'function') {
      throw new Error('raw repair requires a raw store with entries() and verify()');
    }
    const fetched = await this.pool.query('SELECT id,checksum,raw_object_path FROM source_fetches WHERE checksum IS NOT NULL');
    const referenced = new Map();
    for (const row of fetched.rows) {
      const group = referenced.get(row.checksum) ?? [];
      group.push(row);
      referenced.set(row.checksum, group);
    }
    const observedAt = new Date().toISOString();
    const healthy = [];
    const pending = [];
    const orphans = [];
    for (const [checksum, rows] of referenced) {
      const paths = [...new Set(rows.map((row) => row.raw_object_path))];
      const verified = rawStore.verify(checksum, paths.length === 1 ? paths[0] : undefined);
      if (verified.ok && paths.length === 1) {
        healthy.push({ checksum, objectPath: verified.objectPath, sourceFetchIds: rows.map((row) => portId('fetch', row.id)) });
        continue;
      }
      const item = { checksum, objectPath: paths[0] ?? verified.objectPath ?? 'missing', state: 'pending',
        observedAt, reason: paths.length > 1 ? 'source fetches disagree about the raw object path' : verified.reason,
        sourceFetchIds: rows.map((row) => portId('fetch', row.id)) };
      pending.push(item);
      await this.pool.query(`INSERT INTO raw_object_repair
        (checksum,object_path,state,observed_at,reason,source_fetch_ids)
        VALUES ($1,$2,'pending',$3,$4,$5::jsonb) ON CONFLICT (checksum) DO UPDATE SET
        object_path = EXCLUDED.object_path,state = EXCLUDED.state,observed_at = EXCLUDED.observed_at,
        reason = EXCLUDED.reason,source_fetch_ids = EXCLUDED.source_fetch_ids,updated_at = clock_timestamp()`,
      [checksum, item.objectPath, observedAt, item.reason, JSON.stringify(item.sourceFetchIds)]);
    }
    for (const entry of rawStore.entries()) {
      if (referenced.has(entry.checksum)) continue;
      const item = { checksum: entry.checksum, objectPath: entry.objectPath, state: 'retained',
        detectedAs: 'orphan', observedAt, reason: 'orphan raw object retained for operator review' };
      orphans.push(item);
      await this.pool.query(`INSERT INTO raw_object_repair (checksum,object_path,state,observed_at,reason)
        VALUES ($1,$2,'retained',$3,$4) ON CONFLICT (checksum) DO UPDATE SET
        object_path = EXCLUDED.object_path,state = EXCLUDED.state,observed_at = EXCLUDED.observed_at,
        reason = EXCLUDED.reason,updated_at = clock_timestamp()`,
      [item.checksum, item.objectPath, observedAt, item.reason]);
    }
    return { observedAt, healthy, pending, orphans };
  }

  // Read port for the query service: each route runs one statement. Lists are
  // keyset-paged on a unique index and a game is fetched by its unique key, so
  // neither loads more rows than the page, however large the tables grow.
  async listSchools(request) {
    const { limit, cursor } = createPageRequest(request);
    const after = decodePageCursor(cursor, ['string', 'string']);
    const result = await this.pool.query(`SELECT * FROM schools
      ${after ? 'WHERE (provider_id,canonical_source_path) > ($2,$3)' : ''}
      ORDER BY provider_id,canonical_source_path LIMIT $1`, [limit + 1, ...(after ?? [])]);
    return createReadPage(result.rows, limit, (row) => [row.provider_id, row.canonical_source_path], mapSchool);
  }

  async listSeasons(request) {
    const { limit, cursor } = createPageRequest(request);
    const after = decodePageCursor(cursor, ['string', 'string', 'integer']);
    // The redundant two-column bound lets the planner start the schools index
    // scan at the cursor instead of filtering from the first school.
    const result = await this.pool.query(`SELECT s.*,sc.provider_id,sc.canonical_source_path FROM school_seasons s
      JOIN schools sc ON sc.id = s.school_id
      ${after ? `WHERE (sc.provider_id,sc.canonical_source_path) >= ($2,$3)
        AND (sc.provider_id,sc.canonical_source_path,s.ending_year) > ($2,$3,$4::int)` : ''}
      ORDER BY sc.provider_id,sc.canonical_source_path,s.ending_year LIMIT $1`, [limit + 1, ...(after ?? [])]);
    return createReadPage(result.rows, limit, (row) => [row.provider_id, row.canonical_source_path, row.ending_year], mapSeason);
  }

  async listGames(request) {
    const { limit, cursor } = createPageRequest(request);
    const after = decodePageCursor(cursor, ['string', 'string']);
    const result = await this.pool.query(`SELECT g.*,r.data FROM games g ${LATEST_ACCEPTED_GAME_REVISION}
      ${after ? 'WHERE (g.provider_id,g.canonical_box_score_path) > ($2,$3)' : ''}
      ORDER BY g.provider_id,g.canonical_box_score_path LIMIT $1`, [limit + 1, ...(after ?? [])]);
    return createReadPage(result.rows, limit, (row) => [row.provider_id, row.canonical_box_score_path], mapGame);
  }

  // A game key is "<providerId>:<canonical box-score path>". Either part may
  // contain ':' (a host with a port), so every split is tried in one indexed
  // lookup on the (provider_id, canonical_box_score_path) unique key.
  async getGame(key) {
    if (typeof key !== 'string' || !key || key.length > 2048) return null;
    const providers = [];
    const paths = [];
    for (let index = key.indexOf(':'); index > 0; index = key.indexOf(':', index + 1)) {
      providers.push(key.slice(0, index));
      paths.push(key.slice(index + 1));
    }
    if (!providers.length) return null;
    const result = await this.pool.query(`SELECT g.*,r.data FROM unnest($1::text[],$2::text[]) k(provider_id,path)
      JOIN games g ON g.provider_id = k.provider_id AND g.canonical_box_score_path = k.path
      ${LATEST_ACCEPTED_GAME_REVISION} LIMIT 1`, [providers, paths]);
    return result.rowCount ? deepFreeze(mapGame(result.rows[0])) : null;
  }

  // Counts only, in one statement (one snapshot); no entity rows are loaded.
  // The counts still scan their tables, so this is bounded in statements and
  // memory, not in time; see BOUNDARY_CONTRACTS.md.
  async health() {
    const result = await this.pool.query(`SELECT
      (SELECT COALESCE(json_object_agg(state,count),'{}'::json) FROM
        (SELECT state,count(*)::int AS count FROM crawl_jobs GROUP BY state) s) AS job_states,
      (SELECT count(*)::int FROM source_fetches) AS source_fetches,
      (SELECT count(*)::int FROM parse_runs) AS parse_runs,
      (SELECT COALESCE(sum(jsonb_array_length(warnings)),0)::int FROM parse_runs) AS warnings,
      (SELECT count(*)::int FROM unavailable_coverage) AS unavailable_coverage,
      (SELECT count(*)::int FROM reconciliation_issues WHERE status = 'open') AS conflicts,
      (SELECT count(*)::int FROM page_observation_revisions WHERE accepted) AS observations`);
    const row = result.rows[0];
    return deepFreeze({ jobStates: row.job_states, sourceFetches: row.source_fetches, parseRuns: row.parse_runs,
      warnings: row.warnings, unavailableCoverage: row.unavailable_coverage, conflicts: row.conflicts,
      observations: row.observations });
  }

  // Operator status for `cli.mjs status`: job counts by page type and state, and
  // network fetches (cache hits excluded) in the trailing window, in one statement.
  async crawlStatus({ windowMs = 3_600_000 } = {}) {
    const result = await this.pool.query(`SELECT clock_timestamp() AS observed_at,
      (SELECT COALESCE(json_agg(json_build_object('pageType',page_type,'state',state,'count',n)),'[]'::json) FROM
        (SELECT page_type,state,count(*)::int AS n FROM crawl_jobs GROUP BY page_type,state) j) AS jobs,
      (SELECT count(*)::int FROM source_fetches WHERE NOT cache_hit) AS fetches,
      (SELECT count(*)::int FROM source_fetches WHERE NOT cache_hit
        AND fetched_at > clock_timestamp() - ($1::bigint * interval '1 millisecond')) AS window_fetches,
      (SELECT min(fetched_at) FROM source_fetches WHERE NOT cache_hit) AS first_fetch_at,
      (SELECT max(fetched_at) FROM source_fetches WHERE NOT cache_hit) AS last_fetch_at`, [windowMs]);
    const row = result.rows[0];
    return deepFreeze({ observedAt: iso(row.observed_at), jobs: row.jobs, fetches: { total: row.fetches, inWindow: row.window_fetches,
      windowMs, firstAt: iso(row.first_fetch_at), lastAt: iso(row.last_fetch_at) } });
  }
}

const LATEST_ACCEPTED_GAME_REVISION = `LEFT JOIN LATERAL
  (SELECT data FROM normalized_page_revisions WHERE provider_id = g.provider_id
   AND record_key = g.provider_id || ':' || g.canonical_box_score_path
   AND disposition = 'accepted' ORDER BY id DESC LIMIT 1) r ON true`;

function mapSchool(row) {
  return { path: new URL(row.source_url).pathname, name: row.display_name, city: row.city, state: row.state,
    from: row.from_year, to: row.to_year, eligible: row.eligible, provenance: row.provenance };
}

function mapSeason(row) {
  return { schoolSourcePath: `${row.provider_id}:${row.canonical_source_path}`, endingYear: row.ending_year,
    coverageStatus: row.coverage_status, provenance: row.provenance };
}

function mapGame(row) {
  return { ...(row.data ?? {}), gameKey: `${row.provider_id}:${row.canonical_box_score_path}`, provenance: row.provenance };
}

export function createPostgresPersistence(options) { return new PostgresPersistence(options); }

const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function expectedMigrationVersions(directory = MIGRATIONS_DIRECTORY) {
  return readdirSync(directory).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort().map((name) => name.slice(0, -4));
}

// Fail at startup, not on the first query, when the database is unreachable or
// has not had every ordered migration applied. Connection values are never
// included in the error.
export async function assertSchemaCurrent(pool, expected = expectedMigrationVersions()) {
  let rows;
  try {
    ({ rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version'));
  } catch (error) {
    if (error.code === '42P01') throw new Error('database schema is missing: apply migrations/ before starting (schema_migrations does not exist)');
    throw new Error(`database is unavailable (${error.code ?? 'connection failed'}); check PG* settings, PGSSLMODE, and network access`);
  }
  const applied = new Set(rows.map((row) => row.version));
  const missing = expected.filter((version) => !applied.has(version));
  if (missing.length) throw new Error(`database schema is behind: apply migrations/ before starting (missing ${missing.join(', ')})`);
}

export async function openPostgresPersistence({ pool: poolConfig, claimTimeoutMs, onPoolError } = {}) {
  const pool = new Pool({ statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS, ...poolConfig });
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs, onPoolError });
  try {
    await assertSchemaCurrent(persistence.pool);
  } catch (error) {
    await persistence.close().catch(() => {});
    throw error;
  }
  return persistence;
}
