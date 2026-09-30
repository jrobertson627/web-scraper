import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Evidence that the parsers were run against the real Sports Reference captures
// (#123). The captures cannot be in the repository (it is public and the data
// contract is private), so CI skips the tests that read them, and a parser change
// that breaks on real pages would merge green. `npm run parsers:verify` runs those
// tests locally and prints one line that names the exact parser code and the exact
// capture set it ran against; a pull request that changes the parsers must carry
// that line in its description, and CI checks that it matches the code it is
// merging. It proves the run happened against this code, not that it was honest.

// What a parser's output depends on: the parsers themselves, and the contracts
// they build their documents from.
export const PARSER_DIRECTORY = 'src/parsers';
export const PARSER_CONTRACT_FILES = Object.freeze(['src/contracts/parsed-documents.mjs', 'src/contracts/value-state.mjs']);

// A change to any of these needs the evidence.
const NEEDS_EVIDENCE = [/^src\/parsers\//, /^src\/contracts\/(?:parsed-documents|value-state)\.mjs$/, /^fixtures\/sports-reference\/manifest\.json$/];

export const EVIDENCE_PATTERN = /Real-capture verification: passed \(captures ([0-9a-f]{16}), parsers ([0-9a-f]{16}), (\d+) tests, (\d{4}-\d{2}-\d{2})\)/;

export function needsEvidence(changedFiles) {
  return changedFiles.some((file) => NEEDS_EVIDENCE.some((pattern) => pattern.test(file.replaceAll('\\', '/'))));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalized = (text) => String(text).replace(/^﻿/, '').replaceAll('\r\n', '\n');

// The capture set, from the committed manifest: each capture's path and checksum.
export function captureSetId(manifest) {
  const lines = Object.entries(manifest).map(([sitePath, entry]) => `${sitePath} ${entry.sha256}`).sort();
  return sha256(lines.join('\n')).slice(0, 16);
}

// The parser code, from its files' contents (line endings ignored). `files` is a
// list of repository-relative paths and `read` returns a file's text, so the same
// id comes from a working tree and from a git tree.
export function parserCodeId(files, read) {
  const parts = [...files].map((file) => file.replaceAll('\\', '/')).sort().map((file) => `${file}\0${normalized(read(file))}`);
  return sha256(parts.join('\n')).slice(0, 16);
}

export function parserFilesOnDisk(root = '.') {
  const parsers = readdirSync(join(root, PARSER_DIRECTORY)).filter((name) => name.endsWith('.mjs')).map((name) => `${PARSER_DIRECTORY}/${name}`);
  return [...parsers, ...PARSER_CONTRACT_FILES];
}

export function parserCodeIdOnDisk(root = '.') {
  return parserCodeId(parserFilesOnDisk(root), (file) => readFileSync(join(root, file), 'utf8'));
}

export function readManifest(root = '.') {
  return JSON.parse(readFileSync(join(root, 'fixtures/sports-reference/manifest.json'), 'utf8'));
}

// The line to paste into a pull request description.
export function evidenceLine({ captures, parsers, tests, date }) {
  return `Real-capture verification: passed (captures ${captures}, parsers ${parsers}, ${tests} tests, ${date})`;
}

// Whether a pull request description carries evidence for this parser code and
// capture set. Returns { ok, message }.
export function checkEvidence(body, { captures, parsers }) {
  const match = EVIDENCE_PATTERN.exec(String(body ?? ''));
  const how = 'Run `npm run parsers:verify` on a machine that has the captures (fixtures/sports-reference/raw/) and paste the line it prints into the pull request description.';
  if (!match) return { ok: false, message: `This change touches the parsers, so the description must carry a "Real-capture verification: passed (...)" line. ${how}` };
  if (match[1] !== captures) return { ok: false, message: `The evidence names capture set ${match[1]}, but the committed manifest is ${captures}. ${how}` };
  if (match[2] !== parsers) return { ok: false, message: `The evidence names parser code ${match[2]}, but this change's parser code is ${parsers}: the parsers changed after the last verification. ${how}` };
  return { ok: true, message: `Real-capture evidence matches: captures ${captures}, parsers ${parsers}, ${match[3]} tests, ${match[4]}.` };
}
