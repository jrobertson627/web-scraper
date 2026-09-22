import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { runCli, EXIT_CODES } from '../src/application/cli.mjs';
import { authorizationStatus } from '../src/config/authorization.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { contractFingerprint } from '../src/config/data-contract.mjs';

const validPolicy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'test (+ops@example.com)' };
const validScope = { eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };
const validAuthorizationScope = { allowedHosts: ['allowed.example'], ...validScope };
const validDataContract = { providerId: 'p', version: 'v1', retainedFields: ['school', 'games'], attribution: 'Provider', sourceLinksRequired: true, redistribution: 'public', retention: 'indefinite' };

function makeJob(providerId = 'p', absoluteUrl = 'https://allowed.example/page') {
  const sourceUrl = createSourceUrl(providerId, absoluteUrl);
  return { key: `${providerId}:allowed.example/page:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) };
}

function makeClock() {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  return { clock: () => new Date(time), sleep: async (milliseconds) => { time += milliseconds; } };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('fixture composition is replaceable through the source adapter contract', async () => {
  const sourceAdapter = {
    providerId: () => 'alternate-fixture',
    indexUrl: () => createSourceUrl('alternate-fixture', 'https://alternate.example/cbb/schools/'),
    classify: () => 'school_index',
    canonicalize: (sourceUrl) => canonicalizeSourceUrl(sourceUrl),
  };
  const app = createFixtureApplication({ sourceAdapter });
  const result = await app.runWorkerOnce();

  assert.equal(app.config.providerId, 'alternate-fixture');
  assert.equal(sourceAdapter.classify(sourceAdapter.indexUrl()), 'school_index');
  assert.equal(result.jobs.every((job) => job.sourceUrl.providerId === 'alternate-fixture'), true);
  assert.equal(app.transport.calls.every((url) => new URL(url).host === 'alternate.example'), true);
});

test('authorization expiry uses the injected clock in validation and status checks', () => {
  const authorization = { providerId: 'p', status: 'active', uses: ['crawl'], evidenceRef: 'private-record', contractVersion: 'v1', scope: validAuthorizationScope, expiresAt: '2026-01-02T00:00:00.000Z' };
  const beforeExpiry = () => new Date('2026-01-01T00:00:00.000Z');
  const atExpiry = () => new Date('2026-01-02T00:00:00.000Z');
  const input = {
    mode: 'worker', providerId: 'p', allowedHosts: ['allowed.example'], rawStore: 'memory', publication: 'private',
    policy: validPolicy, authorization, dataContract: validDataContract, ...validScope,
  };
  authorization.contractFingerprint = contractFingerprint(validDataContract);

  assert.equal(authorizationStatus(authorization, 'p', 'crawl', beforeExpiry).ok, true);
  assert.equal(authorizationStatus(authorization, 'p', 'crawl', atExpiry).ok, false);
  assert.doesNotThrow(() => validateConfiguration(input, { clock: beforeExpiry }));
  assert.throws(() => validateConfiguration(input, { clock: atExpiry }), /expired/);
});

test('request identifiers remain unique after prior requests are released', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(makeJob());
  const job = persistence.claimNextJob(now, 'worker');
  const first = persistence.acquireRequest(job.key, job.lease, job.sourceUrl.host);
  persistence.releaseRequest(job.key, job.lease);
  const second = persistence.acquireRequest(job.key, job.lease, job.sourceUrl.host);

  assert.equal(first.id, 'request-1');
  assert.equal(second.id, 'request-2');
  assert.notEqual(first.id, second.id);
});

test('disallowed redirect targets are rejected before transport can request them', async () => {
  const time = makeClock();
  const initialUrl = 'https://allowed.example/start';
  const transport = new FixtureTransport(new Map([[initialUrl, { redirectUrl: 'https://blocked.example/secret' }]]));
  const persistence = new InMemoryPersistence(time.clock);
  const rawStore = new MemoryRawStore();
  persistence.addJob(makeJob('p', initialUrl));
  const job = persistence.claimNextJob(time.clock(), 'worker');
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock: time.clock, sleep: time.sleep, policy: validPolicy, allowedHosts: ['allowed.example'] });

  const result = await fetcher.fetch(job, job.lease);

  assert.equal(result.kind, 'operator_stop');
  assert.match(result.reason, /not allowlisted/);
  assert.deepEqual(transport.calls, [initialUrl]);
});

test('raw repair inventories retained orphans and unsafe metadata references', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  const rawStore = new MemoryRawStore();
  const orphan = rawStore.put(Buffer.from('orphan body'));
  const missingChecksum = 'a'.repeat(64);
  const mismatchedChecksum = 'b'.repeat(64);
  persistence.addJob(makeJob());
  const job = persistence.claimNextJob(now, 'worker');
  persistence.recordFetch({ jobKey: job.key, status: 200, checksum: missingChecksum, objectPath: `memory://${missingChecksum}` }, job.lease);
  persistence.recordFetch({ jobKey: job.key, status: 200, checksum: mismatchedChecksum, objectPath: `memory://${mismatchedChecksum}` }, job.lease);
  const repairStore = {
    entries: () => [...rawStore.entries(), { checksum: mismatchedChecksum, objectPath: `memory://${mismatchedChecksum}`, size: 8 }],
    verify: (checksum, objectPath) => {
      if (checksum === missingChecksum) return { ok: false, reason: 'missing raw object', checksum };
      if (checksum === mismatchedChecksum) return { ok: false, reason: 'raw object checksum mismatch', checksum, actualChecksum: 'c'.repeat(64), objectPath };
      return rawStore.verify(checksum, objectPath);
    },
  };

  const result = persistence.repairRawObjects({ rawStore: repairStore });

  assert.deepEqual(result.pending.map((item) => item.checksum).sort(), [missingChecksum, mismatchedChecksum].sort());
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].checksum, orphan.checksum);
  assert.equal(result.orphans[0].state, 'retained');

  const unsafePersistence = new InMemoryPersistence(() => now);
  unsafePersistence.addJob(makeJob());
  const unsafeStore = {
    get: () => ({ checksum: mismatchedChecksum, objectPath: `memory://${mismatchedChecksum}`, body: Buffer.from('tampered') }),
    verify: () => ({ ok: false, reason: 'raw object checksum mismatch' }),
  };
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-1', checksum: mismatchedChecksum }) },
    discovery: {}, parsers: {}, normalizer: {}, persistence: unsafePersistence, rawStore: unsafeStore, clock: () => now,
  });
  await orchestrator.runOnce('worker');
  assert.equal(unsafePersistence.getJob(makeJob().key).state, 'operator_stop');
  assert.equal(unsafePersistence.parseRuns.length, 0);
});

test('worker CLI uses distinct sanitized configuration and adapter exit codes', () => {
  const invalid = spawnSync(process.execPath, ['src/application/cli.mjs', 'worker'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, USER_AGENT: 'test (+ops@example.com)', AUTHORIZATION_JSON: '{"secret":"TOP_SECRET"' },
  });
  assert.equal(invalid.status, EXIT_CODES.configurationRejected);
  assert.match(invalid.stderr, /worker configuration rejected/);
  assert.doesNotMatch(invalid.stderr, /TOP_SECRET|\n\s+at /);

  const dataContract = JSON.stringify({ providerId: 'provider', version: 'v1', retainedFields: ['school'], attribution: 'Provider', sourceLinksRequired: true, redistribution: 'public', retention: 'indefinite' });
  const authorization = JSON.stringify({ providerId: 'provider', status: 'active', uses: ['crawl'], evidenceRef: 'private-record', contractVersion: 'v1', contractFingerprint: contractFingerprint(JSON.parse(dataContract)), scope: { allowedHosts: ['provider.example'], ...validScope } });
  const missingAdapter = spawnSync(process.execPath, ['src/application/cli.mjs', 'worker'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, USER_AGENT: 'test (+ops@example.com)', AUTHORIZATION_JSON: authorization, DATA_CONTRACT_JSON: dataContract },
  });
  assert.equal(missingAdapter.status, EXIT_CODES.sourceAdapterMissing);
  assert.match(missingAdapter.stderr, /no production source adapter/);
  assert.doesNotMatch(missingAdapter.stderr, /\n\s+at /);
});

test('API CLI ingests fixture data before it reports readiness', async () => {
  const port = await availablePort();
  const output = [];
  const running = await runCli({ mode: 'api', env: { PORT: String(port) }, stdout: (message) => output.push(message) });
  try {
    const [schools, seasons, games, health] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/schools`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/seasons`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/games`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()),
    ]);
    assert.equal(schools.length, 2);
    assert.equal(seasons.length, 2);
    assert.equal(games.length, 1);
    assert.equal(health.jobStates.parsed, 7);
    assert.match(output[0], /API ready/);
  } finally {
    await running.close();
  }
});

test('API publication gate evaluates expiry with the fixture clock', async () => {
  const app = createFixtureApplication();
  await app.runWorkerOnce();
  const config = {
    ...app.config,
    mode: 'api',
    publication: 'public',
    dataContract: { ...validDataContract, providerId: app.config.providerId },
  };
  config.authorization = { providerId: app.config.providerId, status: 'active', uses: ['publish'], evidenceRef: 'private-record', contractVersion: 'v1', contractFingerprint: contractFingerprint(config.dataContract), scope: { allowedHosts: [new URL(app.sourceAdapter.indexUrl().absoluteUrl).host], eligibilityPredicate: app.config.eligibilityPredicate, targetEndingYears: app.config.targetEndingYears }, expiresAt: '2026-01-02T00:00:00.000Z' };
  const server = app.createApiServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/schools`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
