import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertTransition, createLeaseToken, createOperatorDisposition } from '../contracts/jobs.mjs';
import { createJob, createQueryModels } from '../contracts/boundaries.mjs';
import { canonicalPathString, createSourceUrl, sourceKey } from '../contracts/source.mjs';
import { writeNormalizedPage } from './postgres-domain.mjs';

const { Pool } = pg;
const CHECKSUM = /^[0-9a-f]{64}$/;
const FINAL_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);
const FAILURE_STATES = new Set(['retry_wait', 'operator_stop', 'parse_failed', 'permanently_failed']);

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function keySql() { return "provider_id || ':' || canonical_path || ':' || page_type"; }
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

export class PostgresPersistence {
  constructor({ pool = new Pool(), claimTimeoutMs = 30_000, authorizeOperator = (id) => Boolean(id) } = {}) {
    if (!Number.isInteger(claimTimeoutMs) || claimTimeoutMs < 1) throw new Error('claimTimeoutMs must be positive');
    this.pool = pool;
    this.claimTimeoutMs = claimTimeoutMs;
    this.authorizeOperator = authorizeOperator;
  }

  async close() { await this.pool.end(); }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async addJob(job) {
    const validated = createJob(job);
    return this.transaction(async (client) => {
      let parentId = null;
      if (validated.parentKey) {
        const parent = await client.query(`SELECT id FROM crawl_jobs WHERE ${keySql()} = $1`, [validated.parentKey]);
        if (!parent.rowCount) throw new Error(`parent job is missing: ${validated.parentKey}`);
        parentId = parent.rows[0].id;
      }
      const inserted = await client.query(`
        INSERT INTO crawl_jobs (provider_id, canonical_path, page_type, source_url, parent_job_id, school_source_path, parser_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (provider_id, canonical_path, page_type) DO NOTHING
        RETURNING *`, [validated.sourceUrl.providerId, dbPath(validated.canonicalPath), validated.pageType,
        validated.sourceUrl.absoluteUrl, parentId, validated.schoolSourcePath ?? null, validated.parserVersion ?? '1']);
      const row = inserted.rows[0] ?? (await client.query(`SELECT * FROM crawl_jobs WHERE ${keySql()} = $1`, [validated.key])).rows[0];
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
      FROM crawl_jobs j LEFT JOIN crawl_jobs p ON p.id = j.parent_job_id WHERE j.provider_id || ':' || j.canonical_path || ':' || j.page_type = $1`, [key]);
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
    const result = await this.pool.query(`UPDATE crawl_jobs SET claim_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
      updated_at = clock_timestamp() WHERE ${keySql()} = $1 AND claim_owner = $2 AND lease_generation = $3
      AND claim_expires_at > clock_timestamp() AND state IN ('fetching','fetched')`,
    [key, lease?.workerId, lease?.generation, this.claimTimeoutMs]);
    if (!result.rowCount) throw new Error(`stale or missing lease for job ${key}`);
  }

  async recoverExpiredClaims() {
    return this.transaction(async (client) => {
      const expired = await client.query(`SELECT j.* FROM crawl_jobs j
        WHERE j.state IN ('fetching','fetched') AND j.claim_expires_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM in_flight_requests r WHERE r.job_id = j.id AND r.released_at IS NULL)
        FOR UPDATE OF j SKIP LOCKED`);
      for (const row of expired.rows) {
        await client.query(`UPDATE crawl_jobs SET state = 'retry_wait', next_allowed_at = clock_timestamp(),
          last_error = 'claim expired before completion', claim_owner = NULL, claim_expires_at = NULL,
          lease_generation = NULL, updated_at = clock_timestamp() WHERE id = $1`, [row.id]);
        await this.recordEvent(client, row, row.state, 'retry_wait', { nextAllowedAt: new Date().toISOString(), lastError: 'claim expired before completion' });
      }
      return expired.rowCount;
    });
  }

  async leasedJob(client, key, lease) {
    const result = await client.query(`SELECT * FROM crawl_jobs WHERE ${keySql()} = $1 FOR UPDATE`, [key]);
    const row = result.rows[0];
    if (!row || !lease || row.claim_owner !== lease.workerId || Number(row.lease_generation) !== lease.generation ||
      !row.claim_expires_at || new Date(row.claim_expires_at) <= new Date()) {
      throw new Error(`stale or missing lease for job ${key}`);
    }
    return row;
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
      WHERE job_id = (SELECT id FROM crawl_jobs WHERE ${keySql()} = $1 AND claim_owner = $3
        AND lease_generation = $2)
        AND lease_generation = $2 AND released_at IS NULL`, [key, lease?.generation, lease?.workerId]);
    if (result.rowCount !== 1) throw new Error('request ownership mismatch');
  }

  async confirmRequestCancellation(key, lease, reason) {
    if (!reason) throw new Error('request cancellation confirmation requires a reason');
    const result = await this.pool.query(`UPDATE in_flight_requests SET released_at = clock_timestamp(), outcome = 'canceled',
      cancellation_reason = $4 WHERE job_id = (SELECT id FROM crawl_jobs WHERE ${keySql()} = $1
      AND claim_owner = $3 AND lease_generation = $2)
      AND lease_generation = $2 AND released_at IS NULL RETURNING *`, [key, lease?.generation, lease?.workerId, reason]);
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
      WHERE j.provider_id || ':' || j.canonical_path || ':' || j.page_type = $1 AND f.checksum IS NOT NULL
      ORDER BY f.fetched_at DESC, f.id DESC LIMIT 1`, [jobKey]);
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
      const found = await client.query(`SELECT * FROM crawl_jobs WHERE ${keySql()} = $1 FOR UPDATE`, [key]);
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

  async queryModels() {
    return this.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const statements = [
        'SELECT * FROM schools ORDER BY provider_id,canonical_source_path',
        `SELECT s.*,sc.provider_id,sc.canonical_source_path FROM school_seasons s
          JOIN schools sc ON sc.id = s.school_id ORDER BY sc.provider_id,sc.canonical_source_path,s.ending_year`,
        `SELECT g.*,r.data FROM games g LEFT JOIN LATERAL
          (SELECT data FROM normalized_page_revisions WHERE provider_id = g.provider_id
           AND record_key = g.provider_id || ':' || g.canonical_box_score_path
           AND disposition = 'accepted' ORDER BY id DESC LIMIT 1) r ON true
          ORDER BY g.provider_id,g.canonical_box_score_path`,
        'SELECT state,count(*)::int AS count FROM crawl_jobs GROUP BY state',
        'SELECT count(*)::int AS count FROM source_fetches',
        `SELECT count(*)::int AS count,
          COALESCE(sum(jsonb_array_length(warnings)),0)::int AS warnings FROM parse_runs`,
        'SELECT count(*)::int AS count FROM unavailable_coverage',
        "SELECT count(*)::int AS count FROM reconciliation_issues WHERE status = 'open'",
        'SELECT count(*)::int AS count FROM page_observation_revisions WHERE accepted',
      ];
      const results = [];
      for (const statement of statements) results.push(await client.query(statement));
      const [schoolRows, seasonRows, gameRows, stateRows, fetchRows, parseRows, coverageRows, conflictRows, observationRows] = results;
      return createQueryModels({
        schools: schoolRows.rows.map((row) => ({ path: new URL(row.source_url).pathname, name: row.display_name,
          city: row.city, state: row.state, from: row.from_year, to: row.to_year,
          eligible: row.eligible, provenance: row.provenance })),
        seasons: seasonRows.rows.map((row) => ({ schoolSourcePath: `${row.provider_id}:${row.canonical_source_path}`,
          endingYear: row.ending_year, coverageStatus: row.coverage_status, provenance: row.provenance })),
        games: gameRows.rows.map((row) => ({ ...(row.data ?? {}),
          gameKey: `${row.provider_id}:${row.canonical_box_score_path}`, provenance: row.provenance })),
        health: { jobStates: Object.fromEntries(stateRows.rows.map((row) => [row.state, row.count])),
          sourceFetches: fetchRows.rows[0].count, parseRuns: parseRows.rows[0].count,
          warnings: parseRows.rows[0].warnings, unavailableCoverage: coverageRows.rows[0].count,
          conflicts: conflictRows.rows[0].count, observations: observationRows.rows[0].count },
      });
    });
  }
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

export async function openPostgresPersistence({ pool: poolConfig, claimTimeoutMs } = {}) {
  const persistence = new PostgresPersistence({ pool: new Pool(poolConfig), claimTimeoutMs });
  try {
    await assertSchemaCurrent(persistence.pool);
  } catch (error) {
    await persistence.close().catch(() => {});
    throw error;
  }
  return persistence;
}
