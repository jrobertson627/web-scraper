import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createParseResult, createSnapshot, createJob, createNormalizedPage } from '../src/contracts/boundaries.mjs';
import { createProvenance } from '../src/contracts/provenance.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { assertSourceValue, sourceValue } from '../src/contracts/value-state.mjs';
import { ParserRegistry } from '../src/parsers/index.mjs';
import { Normalizer } from '../src/domain/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

function snapshot(body = { score: 0 }) {
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  return createSnapshot({ jobKey: 'job', sourceUrl, body: Buffer.from(JSON.stringify(body)), sourceUrlFrom: (target) => createSourceUrl('provider', target, sourceUrl.absoluteUrl) });
}

function parser(version, transform) {
  return {
    pageType: () => 'season', version: () => version,
    parse: (input) => createParseResult({ kind: 'valid', document: transform(JSON.parse(input.body.toString())), warnings: [`parser-${version}`] }),
  };
}

test('source values preserve blank, unavailable, explicit null, and numeric zero', () => {
  assert.deepEqual(sourceValue(''), { state: 'blank' });
  assert.deepEqual(sourceValue(undefined), { state: 'unavailable', reason: 'source_unavailable' });
  assert.deepEqual(sourceValue(null), { state: 'null' });
  assert.deepEqual(sourceValue(0), { state: 'present', value: 0 });
  assert.throws(() => assertSourceValue({ state: 'blank', value: 0 }), /must not contain/);
});

test('versioned parser registry reprocesses immutable snapshots offline', () => {
  const rawStore = new MemoryRawStore();
  const raw = rawStore.put(snapshot().body);
  const stored = rawStore.get(raw.checksum);
  const offlineSnapshot = snapshot(JSON.parse(stored.body.toString()));
  const registry = new ParserRegistry()
    .register(parser('1', (document) => ({ ...document, projection: 'v1' })))
    .register(parser('2', (document) => ({ ...document, projection: 'v2' })));

  assert.equal(registry.parse('season', '1', offlineSnapshot).document.projection, 'v1');
  const upgraded = registry.parse('season', '2', offlineSnapshot);
  assert.equal(upgraded.document.projection, 'v2');
  assert.deepEqual(upgraded.warnings, ['parser-2']);
  assert.equal(Object.isFrozen(upgraded.document), true);
  assert.throws(() => registry.register(parser('2', (value) => value)), /duplicate/);
  assert.throws(() => registry.get('season', '3'), /no parser registered/);
});

test('normalization retains explicit zero, null identity, status, and warning-bearing observations', () => {
  const canonicalPath = canonicalizeSourceUrl(createSourceUrl('provider', 'https://allowed.example/box/one'));
  const page = new Normalizer().normalize('box_score', {
    date: null, status: 'final', context: 'neutral', home: 'A', away: 'B', homeScore: 0, awayScore: 1, playerSourceId: null,
  }, { jobKey: 'box', canonicalPath, observations: [{ kind: 'warning', message: 'partial row' }] });
  assert.equal(page.data.teams[0].finalScore, 0);
  assert.equal(page.data.gameDate, null);
  assert.equal(page.data.playerSourceId, null);
  assert.equal(page.data.status, 'final');
  assert.equal(page.observations[0].message, 'partial row');
});

test('conflicting normalized facts preserve the accepted record and both provenance lineages', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/box/one');
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  const job = createJob({ key: 'box', pageType: 'box_score', sourceUrl, canonicalPath });
  persistence.addJob(job);
  const claimed = persistence.claimNextJob(now, 'worker');
  const page = (score) => createNormalizedPage({ jobKey: 'box', kind: 'game', identity: 'game', data: { score }, observations: [{ kind: 'game_log', parentKey: 'parent', rowIndex: 0 }] });
  const provenance = (sourceFetchId, parserVersion) => createProvenance({ providerId: 'provider', canonicalPath, sourceUrl, sourceFetchId, parserName: 'box_score', parserVersion, parsedAt: now.toISOString() });

  persistence.commitPage(page(70), provenance('fetch-1', '1'), claimed.lease);
  persistence.commitPage(page(71), provenance('fetch-2', '2'), claimed.lease);

  assert.equal(persistence.pages.get('game').data.score, 70);
  assert.equal(persistence.reconciliationIssues.length, 1);
  assert.equal(persistence.reconciliationIssues[0].details.previous.provenance.sourceFetchId, 'fetch-1');
  assert.equal(persistence.reconciliationIssues[0].details.current.provenance.sourceFetchId, 'fetch-2');
  assert.equal(persistence.observationHistory.length, 2);
});

test('normalized revision migration retains accepted and quarantined parser lineages', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '005_parser_normalization.sql'), 'utf8');
  assert.match(sql, /normalized_page_revisions/);
  assert.match(sql, /source_fetch_id BIGINT NOT NULL REFERENCES source_fetches/);
  assert.match(sql, /parser_version TEXT NOT NULL/);
  assert.match(sql, /'accepted','quarantined'/);
  assert.match(sql, /provenance JSONB NOT NULL/);
});
