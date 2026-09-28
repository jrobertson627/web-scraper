import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// fixtures/without-pg.cjs makes the pg driver unresolvable, as if it were not
// installed (#92). Only PERSISTENCE=postgres should ever need it.
const WITHOUT_PG = ['--require', './fixtures/without-pg.cjs'];

function runWithoutPg(args) {
  return spawnSync(process.execPath, [...WITHOUT_PG, ...args], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
}

function sourceModules(directory = 'src') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceModules(path);
    return entry.name.endsWith('.mjs') ? [relative(process.cwd(), path)] : [];
  });
}

test('local mode runs the fixture chain without the pg driver installed', () => {
  const result = runWithoutPg(['src/application/cli.mjs', 'local']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture local ready/);
  assert.match(result.stdout, /"lifecycle": "stopped"/);
});

test('every source module loads without pg; only a real pool needs the driver', () => {
  const imports = sourceModules().map((file) => `await import(${JSON.stringify(pathToFileURL(file).href)});`).join('\n');
  const script = `${imports}
    const { PostgresPersistence, openPostgresPersistence } = await import(${JSON.stringify(pathToFileURL('src/persistence/postgres.mjs').href)});
    new PostgresPersistence({ pool: { on() {}, async end() {} } });
    try { new PostgresPersistence(); console.log('real pool created'); } catch (error) { console.log('real pool refused:', error.code); }
    await openPostgresPersistence().then(() => console.log('opened'), (error) => console.log('open refused:', error.code));`;
  const result = runWithoutPg(['--input-type=module', '-e', script]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /real pool refused: MODULE_NOT_FOUND/);
  assert.match(result.stdout, /open refused: MODULE_NOT_FOUND/);
});
