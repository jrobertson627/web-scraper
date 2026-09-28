import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationRoot = join(process.cwd(), 'migrations');
const migrations = readdirSync(migrationRoot).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
const sql = migrations.map((name) => readFileSync(join(migrationRoot, name), 'utf8')).join('\n');

test('foundation migrations are ordered, repeat-safe, and record every applied version', () => {
  assert.deepEqual(migrations.slice(0, 8), [
    '001_foundation.sql', '002_job_lifecycle.sql', '003_authorization_contract.sql', '004_schema_hardening.sql', '005_parser_normalization.sql',
    '006_http_cache_metadata.sql', '007_postgres_repositories.sql', '008_parsed_document_storage.sql',
  ]);
  assert.ok(migrations.includes('009_worker_robustness.sql'));
  assert.equal(new Set(migrations.map((name) => name.slice(0, 3))).size, migrations.length, 'migration numbers are unique');
  for (const version of migrations.map((name) => name.slice(0, -4))) {
    assert.match(sql, new RegExp(`schema_migrations[^;]*${version}|${version}[^;]*schema_migrations`, 's'));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
});

test('schema includes provider-scoped durable identities, provenance, claims, repair, and publication gates', () => {
  for (const table of [
    'crawl_jobs', 'source_fetches', 'parse_runs', 'schools', 'school_aliases', 'school_seasons', 'season_rosters',
    'players', 'games', 'game_teams', 'team_game_stats', 'player_game_stats', 'team_seasons', 'team_season_stats',
    'player_season_stats', 'game_log_rows', 'game_log_row_stats',
    'game_observations', 'unavailable_coverage', 'reconciliation_issues', 'raw_object_repair', 'in_flight_requests',
    'host_request_schedule', 'operator_dispositions', 'authorization_records', 'publication_policies',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  assert.match(sql, /UNIQUE \(provider_id, canonical_path, page_type\)/);
  assert.match(sql, /UNIQUE \(provider_id, canonical_box_score_path\)/);
  assert.match(sql, /one_active_request_per_host/);
  assert.match(sql, /source_fetches_raw_reference_check/);
  assert.match(sql, /http_status <> 304/);
  assert.match(sql, /raw_object_repair_checksum_check/);
  assert.match(sql, /publication_policies_redistribution_check/);
  assert.match(sql, /source_fetches_cache_hit_reuse_check/);
  assert.match(sql, /claim_generation BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /one_active_request_per_job/);
  assert.match(sql, /ALTER TABLE school_seasons ALTER COLUMN provenance SET NOT NULL/);
});

test('migration hardening preserves explicit state and provenance invariants', () => {
  assert.match(sql, /state IN \('pending','fetching','fetched','parsed','retry_wait','permanently_failed','parse_failed','operator_stop'\)/);
  assert.match(sql, /job_state_events/);
  assert.match(sql, /CHECK \(status IN \('valid','structural_failure'\)\)/);
  assert.match(sql, /provenance JSONB NOT NULL/);
  assert.match(sql, /source_fetch_ids JSONB NOT NULL/);
});

test('one claim CHECK replaces the overlapping 001 and 004 claim constraints', () => {
  const consolidation = readFileSync(join(migrationRoot, '011_claim_check_consolidation.sql'), 'utf8').replaceAll('\r\n', '\n');
  // Drops 001's unnamed claim CHECK found by its definition, then re-adds the 004 name with the combined rule.
  assert.match(consolidation, /conname <> 'crawl_jobs_claim_state_check'\s+AND pg_get_constraintdef\(oid\) LIKE '%claim_owner IS NOT NULL%'/);
  assert.match(consolidation, /IF legacy IS NOT NULL THEN\s+EXECUTE format\('ALTER TABLE crawl_jobs DROP CONSTRAINT %I', legacy\);/);
  assert.match(consolidation, /ADD CONSTRAINT crawl_jobs_claim_state_check CHECK \(\s+CASE WHEN state IN \('fetching','fetched'\)\s+THEN claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL AND lease_generation IS NOT NULL\s+ELSE claim_owner IS NULL AND claim_expires_at IS NULL AND lease_generation IS NULL/);
  // 004 skips its ADD when the name exists, so a repeat run of every file keeps the combined rule.
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_claim_state_check'\)/);
});

test('parsed-document storage uses named core stat columns with value states beside them', () => {
  // Normalized to LF so a Windows checkout with core.autocrlf still matches the multi-line column list.
  const storage = readFileSync(join(migrationRoot, '008_parsed_document_storage.sql'), 'utf8').replaceAll('\r\n', '\n');
  const core = 'minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,\n  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,';
  for (const table of ['team_game_stats', 'player_game_stats', 'team_season_stats', 'player_season_stats', 'game_log_row_stats']) {
    const definition = storage.slice(storage.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
    const body = definition.slice(0, definition.indexOf(');'));
    assert.ok(body.includes(core), `${table} has the sixteen core columns`);
    assert.match(body, /value_states JSONB NOT NULL/);
  }
  assert.match(storage, /column_name = 'stat_name'\) THEN\s+DROP TABLE team_game_stats;/);
  assert.match(storage, /DROP TABLE IF EXISTS player_game_basic_stats;/);
  assert.match(storage, /location TEXT CHECK \(location IN \('home','away','neutral'\)\)/);
});
