import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { EXIT_CODES, runCli } from '../src/application/cli.mjs';
import { FileRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';

// The offline commands OPERATIONS_RUNBOOK.md relies on: robots:check reads a
// saved robots.txt, repair:raw inventories the raw store. Neither makes a request.

function robotsCheck(body) {
  const directory = mkdtempSync(join(tmpdir(), 'robots-'));
  const file = join(directory, 'robots.txt');
  if (typeof body === 'string') writeFileSync(file, body);
  return spawnSync(process.execPath, ['scripts/robots-check.mjs', ...(body === null ? [] : [file])], { encoding: 'utf8', windowsHide: true });
}

test('robots:check passes when the adapter already refuses every /cbb/ rule, and fails when robots.txt adds one', () => {
  const current = robotsCheck('User-agent: *\nDisallow: /cbb/boxscores/index.cgi?*\nDisallow: /cbb/req/\nDisallow: /cbb/short/\nDisallow: /cbb/nocdn/\nDisallow: /cfb/req/\n');
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /robots.txt check passed/);
  const changed = robotsCheck('User-agent: *\nDisallow: /cbb/req/\nDisallow: /cbb/players/\n');
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /does not refuse: \/cbb\/players\//);
  assert.equal(robotsCheck('<html>Just a moment...</html>').status, 2, 'a challenge page is not a robots.txt');
  assert.equal(robotsCheck(null).status, 2);
});

test('repair:raw prints the raw store inventory and exits 5 when an object is pending repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-'));
  const persistence = new InMemoryPersistence();
  persistence.close = async () => {};
  const app = createFixtureApplication({ sharedState: { persistence, rawStore: new FileRawStore(root) } });
  await app.runWorkerOnce();
  const env = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET', RAW_STORE_ROOT: root };
  const output = [];
  const errors = [];
  const run = (overrides) => runCli({ mode: 'repair', env: { ...env, ...overrides }, stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    openPostgres: async () => persistence });
  const healthy = await run({});
  assert.equal(healthy.exitCode, EXIT_CODES.success);
  assert.deepEqual(JSON.parse(output.at(-1)).counts, { healthy: healthy.report.healthy.length, pending: 0, orphans: 0, temporary: 0 });
  assert.ok(healthy.report.healthy.length > 0);

  persistence.sourceFetches.push({ id: 'fetch-lost', checksum: 'f'.repeat(64), objectPath: `file://${join(root, 'ff', 'f'.repeat(64))}` });
  const damaged = await run({});
  assert.equal(damaged.exitCode, EXIT_CODES.reconciliationFailed);
  assert.deepEqual(damaged.report.pending.map(({ defect, sourceFetchIds }) => [defect, sourceFetchIds]), [['missing', ['fetch-lost']]]);

  assert.equal((await run({ PERSISTENCE: 'memory' })).exitCode, EXIT_CODES.configurationRejected);
  assert.equal((await run({ RAW_STORE_ROOT: 'relative/raw' })).exitCode, EXIT_CODES.configurationRejected);
  assert.doesNotMatch(errors.join(' '), /TOP_SECRET/);
});
