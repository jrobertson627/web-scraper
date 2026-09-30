// `npm run parsers:verify` (#123): runs the tests that read the real Sports
// Reference captures, refusing to count a skipped one, and prints the line a pull
// request that changes the parsers must carry. It makes no request. Exit 0: every
// capture-backed test ran and passed. Exit 1: one failed or was skipped. Exit 2: the
// captures are missing or do not match the committed manifest.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EVIDENCE_PATTERN, captureSetId, evidenceLine, parserCodeIdOnDisk, readManifest } from './parser-evidence.mjs';

const manifest = readManifest();
const problems = [];
for (const [sitePath, entry] of Object.entries(manifest)) {
  const file = new URL(`../fixtures/sports-reference/${entry.file}`, import.meta.url);
  if (!existsSync(file)) { problems.push(`${sitePath}: missing (${entry.file})`); continue; }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== entry.sha256) problems.push(`${sitePath}: checksum ${actual.slice(0, 12)} does not match the manifest's ${entry.sha256.slice(0, 12)}`);
}
if (problems.length) {
  console.error('The real captures are not all present and unchanged in fixtures/sports-reference/raw/:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('Capture them as fixtures/sports-reference/README.md describes; this command never fetches.');
  process.exit(2);
}

// Every test file that reads a capture (not this command's own test, which runs it).
const testDirectory = new URL('../test/', import.meta.url);
const files = readdirSync(testDirectory).filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => name !== 'parser-evidence.test.mjs' && readFileSync(new URL(name, testDirectory), 'utf8').includes('captureSkip')).map((name) => `test/${name}`).sort();

// NODE_TEST_CONTEXT marks a process as already inside a test run, which would change its output when this is run from one.
const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env;
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env });
const count = (label) => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(run.stdout)?.[1] ?? Number.NaN);
const totals = { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
if (run.status !== 0 || totals.fail !== 0 || Number.isNaN(totals.tests)) {
  console.error(run.stdout.split('\n').filter((line) => /^\s*not ok|^# (?:tests|pass|fail)/.test(line)).join('\n'));
  console.error(`The capture-backed tests failed (${totals.fail} failing of ${totals.tests}).`);
  process.exit(1);
}
if (totals.skipped !== 0) {
  console.error(`${totals.skipped} capture-backed test(s) were skipped, so the parsers were not fully checked against the real pages.`);
  process.exit(1);
}

const line = evidenceLine({ captures: captureSetId(manifest), parsers: parserCodeIdOnDisk(), tests: totals.pass, date: new Date().toISOString().slice(0, 10) });
if (!EVIDENCE_PATTERN.test(line)) throw new Error('internal: the evidence line does not match its own pattern');
console.log(`${files.length} test files, ${totals.pass} tests passed against ${Object.keys(manifest).length} real captures.`);
console.log('Paste this line into the pull request description:');
console.log('');
console.log(line);
