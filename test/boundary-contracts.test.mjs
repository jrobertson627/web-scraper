import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as apiPublic from 'web-scraper-foundation/api';
import * as discoveryPublic from 'web-scraper-foundation/discovery';
import * as domainPublic from 'web-scraper-foundation/domain';
import * as fetcherPublic from 'web-scraper-foundation/fetcher';
import * as parsersPublic from 'web-scraper-foundation/parsers';
import * as persistencePublic from 'web-scraper-foundation/persistence';
import {
  assertBoundaryPort,
  createDiscoveryResult,
  createFetchResult,
  createJob,
  createNormalizedPage,
  createParseResult,
  createQueryModels,
  createSnapshot,
  createSourceUrl,
  canonicalizeSourceUrl,
} from 'web-scraper-foundation/contracts';
import { createFixtureApplication } from '../src/application/composition-root.mjs';

test('package public exports expose entry points without fixture adapters', () => {
  assert.deepEqual(Object.keys(fetcherPublic), ['Fetcher']);
  assert.deepEqual(Object.keys(discoveryPublic), ['Discovery']);
  assert.deepEqual(Object.keys(parsersPublic), ['ParserRegistry']);
  assert.deepEqual(Object.keys(domainPublic), ['Normalizer']);
  assert.deepEqual(Object.keys(persistencePublic), ['createPostgresPersistence', 'createRawStore']);
  assert.deepEqual(Object.keys(apiPublic).sort(), ['createApiServer', 'createQueryService']);
});

test('boundary data constructors validate and freeze consumer-facing values', () => {
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/page');
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  const job = createJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath });
  const body = Buffer.from('{"ok":true}');
  const snapshot = createSnapshot({ jobKey: job.key, sourceUrl, body, sourceUrlFrom: () => sourceUrl });
  body.fill(0);
  const discovery = createDiscoveryResult({ childJobs: [job], observations: [{ kind: 'link' }] });
  const parsed = createParseResult({ kind: 'valid', document: { ok: true } });
  const normalized = createNormalizedPage({ jobKey: job.key, kind: 'season', identity: job.key, data: parsed.document, childJobs: discovery.childJobs });
  const queries = createQueryModels({ seasons: [normalized.data], health: { parsed: 1 } });

  for (const value of [job, snapshot, discovery, parsed, normalized, queries, queries.health]) assert.equal(Object.isFrozen(value), true);
  assert.equal(snapshot.body.toString(), '{"ok":true}');
  assert.throws(() => createFetchResult({ kind: 'fetched' }), /sourceFetchId/);
  assert.throws(() => createParseResult({ kind: 'structural_failure' }), /requires error/);
});

test('composition root validates all six boundary ports and API stays read-only', () => {
  const app = createFixtureApplication();
  assertBoundaryPort('fetcher', app.orchestrator.fetcher);
  assertBoundaryPort('discovery', app.orchestrator.discovery);
  assertBoundaryPort('parsers', app.orchestrator.parsers);
  assertBoundaryPort('domain', app.orchestrator.normalizer);
  assertBoundaryPort('persistence', app.orchestrator.persistence);
  assertBoundaryPort('api', app.queries);
  assert.deepEqual(Object.keys(app.queries).sort(), ['getGame', 'health', 'listGames', 'listSchools', 'listSeasons']);
  assert.equal('claimNextJob' in app.queries, false);
  assert.equal('fetch' in app.queries, false);
  assert.throws(() => assertBoundaryPort('fetcher', {}), /missing fetch/);
});

test('boundary implementation imports obey one-way dependency rules', () => {
  const rules = new Map([
    ['src/fetcher/index.mjs', ['node:', '../contracts/', './']],
    ['src/fetcher/http-transport.mjs', ['node:']],
    ['src/discovery/index.mjs', ['../contracts/']],
    ['src/parsers/index.mjs', ['../contracts/']],
    ['src/domain/index.mjs', ['../contracts/']],
    ['src/persistence/index.mjs', ['node:', '../contracts/']],
    ['src/api/index.mjs', ['node:', '../config/']],
  ]);
  for (const [file, allowedPrefixes] of rules) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const dependency of imports) {
      assert.equal(
        allowedPrefixes.some((prefix) => dependency.startsWith(prefix)),
        true,
        `${file} imports forbidden dependency ${dependency}`,
      );
    }
  }
});
