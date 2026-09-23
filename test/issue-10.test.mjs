import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationRoot = join(process.cwd(), 'migrations');
const migrations = readdirSync(migrationRoot).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
const sql = migrations.map((name) => readFileSync(join(migrationRoot, name), 'utf8')).join('\n');

test('foundation migrations are ordered, repeat-safe, and record every applied version', () => {
  assert.deepEqual(migrations, [
    '001_foundation.sql', '002_job_lifecycle.sql', '003_authorization_contract.sql', '004_schema_hardening.sql', '005_parser_normalization.sql',
    '006_http_cache_metadata.sql', '007_postgres_repositories.sql',
  ]);
  for (const version of ['001_foundation', '002_job_lifecycle', '003_authorization_contract', '004_schema_hardening', '005_parser_normalization', '006_http_cache_metadata', '007_postgres_repositories']) {
    assert.match(sql, new RegExp(`schema_migrations[^;]*${version}|${version}[^;]*schema_migrations`, 's'));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
});

test('schema includes provider-scoped durable identities, provenance, claims, repair, and publication gates', () => {
  for (const table of [
    'crawl_jobs', 'source_fetches', 'parse_runs', 'schools', 'school_aliases', 'school_seasons', 'season_rosters',
    'players', 'games', 'game_teams', 'team_game_stats', 'player_game_basic_stats', 'player_game_advanced_stats',
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
