import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_PATTERN, PARSER_CONTRACT_FILES, captureSetId, checkEvidence, evidenceLine, needsEvidence, parserCodeId, parserCodeIdOnDisk, parserFilesOnDisk, readManifest,
} from '../scripts/parser-evidence.mjs';
import { captureManifest, captureSkip } from '../fixtures/sports-reference/captures.mjs';

// #123: a parser change carries evidence that the real-capture tests passed.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(root, 'scripts', 'check-parser-evidence.mjs');

test('the capture set is named by its committed manifest, whatever the order', () => {
  const manifest = { '/a/': { file: 'raw/a', sha256: 'aa' }, '/b/': { file: 'raw/b', sha256: 'bb' } };
  const reordered = { '/b/': manifest['/b/'], '/a/': manifest['/a/'] };
  assert.match(captureSetId(manifest), /^[0-9a-f]{16}$/);
  assert.equal(captureSetId(manifest), captureSetId(reordered));
  assert.notEqual(captureSetId(manifest), captureSetId({ ...manifest, '/b/': { file: 'raw/b', sha256: 'cc' } }), 'a changed capture is a different set');
  assert.notEqual(captureSetId(manifest), captureSetId({ '/a/': manifest['/a/'] }), 'a missing capture is a different set');
  assert.equal(captureSetId(readManifest()), captureSetId(captureManifest));
});

test('the parser code id follows the code, not line endings or file order', () => {
  const files = { 'src/parsers/a.mjs': 'export const a = 1;\n', 'src/parsers/b.mjs': 'export const b = 2;\n' };
  const id = parserCodeId(Object.keys(files), (file) => files[file]);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(parserCodeId(Object.keys(files).reverse(), (file) => files[file]), id);
  assert.equal(parserCodeId(Object.keys(files), (file) => files[file].replaceAll('\n', '\r\n')), id, 'CRLF and LF agree');
  assert.equal(parserCodeId(Object.keys(files), (file) => `﻿${files[file]}`), id, 'a byte-order mark is ignored');
  assert.notEqual(parserCodeId(Object.keys(files), (file) => files[file].replace('= 2', '= 3')), id, 'any edit changes it');
  assert.notEqual(parserCodeId(['src/parsers/a.mjs'], (file) => files[file]), id, 'a missing file changes it');
});

test('the parser code id covers every parser and the documents they build', () => {
  const files = parserFilesOnDisk();
  for (const file of ['src/parsers/season.mjs', 'src/parsers/box-score.mjs', 'src/parsers/school-index.mjs', ...PARSER_CONTRACT_FILES]) assert.ok(files.includes(file), file);
  assert.match(parserCodeIdOnDisk(), /^[0-9a-f]{16}$/);
});

test('only parser-related changes need evidence', () => {
  for (const file of ['src/parsers/season.mjs', 'src/contracts/parsed-documents.mjs', 'src/contracts/value-state.mjs', 'fixtures/sports-reference/manifest.json', 'src\\parsers\\game-log.mjs']) {
    assert.equal(needsEvidence([file]), true, file);
  }
  for (const file of ['src/fetcher/index.mjs', 'README.md', 'test/season-parser.test.mjs', 'src/contracts/source.mjs', 'fixtures/sports-reference/README.md']) assert.equal(needsEvidence([file]), false, file);
  assert.equal(needsEvidence(['README.md', 'src/parsers/box-score.mjs']), true);
  assert.equal(needsEvidence([]), false);
});

test('a description passes only with a line naming this parser code and this capture set', () => {
  const expected = { captures: '0123456789abcdef', parsers: 'fedcba9876543210' };
  const line = evidenceLine({ ...expected, tests: 60, date: '2026-09-30' });
  assert.match(line, EVIDENCE_PATTERN);
  assert.equal(checkEvidence(`## Summary\n\nFixes the season parser.\n\n${line}\n`, expected).ok, true);
  assert.match(checkEvidence('Fixes the season parser.', expected).message, /must carry a "Real-capture verification: passed/);
  assert.equal(checkEvidence(undefined, expected).ok, false);
  assert.match(checkEvidence(line.replace(expected.captures, '1111111111111111'), expected).message, /names capture set 1111111111111111/);
  assert.match(checkEvidence(line.replace(expected.parsers, '2222222222222222'), expected).message, /parsers changed after the last verification/);
  assert.equal(checkEvidence('Real-capture verification: failed (captures 0123456789abcdef, parsers fedcba9876543210, 60 tests, 2026-09-30)', expected).ok, false, 'only a pass counts');
  assert.match(checkEvidence('x', expected).message, /npm run parsers:verify/);
});

// The CI script, against a throwaway git repository.
function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'parser-evidence-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-C', directory, ...args], { encoding: 'utf8' });
  const write = (file, text) => { mkdirSync(dirname(join(directory, file)), { recursive: true }); writeFileSync(join(directory, file), text); };
  git('init', '-q', '-b', 'main');
  write('src/parsers/season.mjs', 'export const season = 1;\n');
  write('src/parsers/box-score.mjs', 'export const box = 1;\n');
  write('src/contracts/parsed-documents.mjs', 'export const documents = 1;\n');
  write('src/contracts/value-state.mjs', 'export const states = 1;\n');
  write('src/fetcher/index.mjs', 'export const fetcher = 1;\n');
  write('fixtures/sports-reference/manifest.json', JSON.stringify({ '/cbb/schools/': { file: 'raw/schools', sha256: 'ab'.repeat(32) } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  return {
    directory, git, write, base,
    commit: (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD').trim(); },
    check: (head, body) => spawnSync(process.execPath, [CHECKER], { cwd: directory, encoding: 'utf8', env: { ...process.env, PR_BODY: body, BASE_SHA: base, HEAD_SHA: head } }),
    evidence: (tests = 60) => evidenceLine({ captures: captureSetId(readManifest(directory)), parsers: parserCodeIdOnDisk(directory), tests, date: '2026-09-30' }),
  };
}

test('CI: a change outside the parsers needs no evidence', () => {
  const repo = repository();
  try {
    repo.write('src/fetcher/index.mjs', 'export const fetcher = 2;\n');
    const result = repo.check(repo.commit('fetcher'), '');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /evidence is not needed/);
  } finally { rmSync(repo.directory, { recursive: true, force: true }); }
});

test('CI: a parser change without evidence fails and says what to run', () => {
  const repo = repository();
  try {
    repo.write('src/parsers/season.mjs', 'export const season = 2;\n');
    const result = repo.check(repo.commit('season parser'), 'Fixes the season parser.');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /::error::.*Real-capture verification: passed/);
    assert.match(result.stdout, /npm run parsers:verify/);
    assert.match(result.stdout, /Changed: src\/parsers\/season\.mjs/);
  } finally { rmSync(repo.directory, { recursive: true, force: true }); }
});

test('CI: evidence for this parser code passes, and goes stale when the parsers change again', () => {
  const repo = repository();
  try {
    repo.write('src/parsers/box-score.mjs', 'export const box = 2;\n');
    const head = repo.commit('box score parser');
    const line = repo.evidence();
    const passed = repo.check(head, `## Summary\n\nbox score.\n\n${line}\n`);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /evidence matches/);

    // The parser changed after the verification: the old line no longer matches.
    repo.write('src/parsers/box-score.mjs', 'export const box = 3;\n');
    const later = repo.commit('another box score change');
    const stale = repo.check(later, line);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /parsers changed after the last verification/);
    // Re-running the verification gives a line that matches the new code.
    assert.equal(repo.check(later, repo.evidence()).status, 0);
  } finally { rmSync(repo.directory, { recursive: true, force: true }); }
});

test('CI: a new capture set (a manifest change) needs fresh evidence', () => {
  const repo = repository();
  try {
    const before = repo.evidence();
    repo.write('fixtures/sports-reference/manifest.json', JSON.stringify({ '/cbb/schools/': { file: 'raw/schools', sha256: 'cd'.repeat(32) } }));
    const head = repo.commit('recapture');
    const stale = repo.check(head, before);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /names capture set/);
    assert.equal(repo.check(head, repo.evidence()).status, 0);
  } finally { rmSync(repo.directory, { recursive: true, force: true }); }
});

test('CI: the description is read from the environment and needs both SHAs', () => {
  const missing = spawnSync(process.execPath, [CHECKER], { cwd: root, encoding: 'utf8', env: { ...process.env, BASE_SHA: '', HEAD_SHA: '' } });
  assert.equal(missing.status, 2);
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(workflow, /parser-evidence:[\s\S]*fetch-depth: 0[\s\S]*PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{ github\.event\.pull_request\.body \}\}/, 'the description is never spliced into a command');
  const template = readFileSync(join(root, '.github/pull_request_template.md'), 'utf8');
  assert.match(template, /npm run parsers:verify/);
  assert.match(template, /Real-capture verification: passed/);
});

test('parsers:verify runs the capture-backed tests and prints a line that matches this code', { skip: captureSkip(...Object.keys(captureManifest)) }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/parsers-verify.mjs')], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const match = EVIDENCE_PATTERN.exec(run.stdout);
  assert.ok(match, run.stdout);
  assert.equal(match[1], captureSetId(captureManifest));
  assert.equal(match[2], parserCodeIdOnDisk());
  assert.ok(Number(match[3]) > 0);
  assert.equal(checkEvidence(run.stdout, { captures: captureSetId(captureManifest), parsers: parserCodeIdOnDisk() }).ok, true);
});
