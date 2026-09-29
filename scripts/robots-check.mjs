// Checks a saved robots.txt against the Disallow rules the Sports Reference
// adapter already refuses (OPERATIONS_RUNBOOK.md, before each bulk run). It
// reads a file and makes no request; fetch robots.txt yourself first.
// Usage: node scripts/robots-check.mjs robots.txt
// Exit 0: every /cbb/ rule is refused. Exit 1: the adapter must be updated
// before crawling. Exit 2: usage.
import { readFileSync } from 'node:fs';
import { SPORTS_REFERENCE_DISALLOWED_PATHS, unrefusedRobotsRules } from '../src/application/sports-reference-source-adapter.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run robots:check -- <saved robots.txt>');
  process.exit(2);
}
let body;
try { body = readFileSync(file, 'utf8'); } catch (error) {
  console.error(`cannot read ${file}: ${error.code ?? error.message}`);
  process.exit(2);
}
if (!/user-agent\s*:/i.test(body)) {
  console.error(`${file} does not look like a robots.txt (no User-agent line); save the file itself, not an error page`);
  process.exit(2);
}
const unrefused = unrefusedRobotsRules(body);
if (unrefused.length) {
  console.log(`robots.txt disallows /cbb/ paths the adapter does not refuse: ${unrefused.join(', ')}`);
  console.log('Add them to SPORTS_REFERENCE_DISALLOWED_PATHS (src/application/sports-reference-source-adapter.mjs) before crawling.');
  process.exit(1);
}
console.log(`robots.txt check passed: every /cbb/ Disallow rule is refused by the adapter (${SPORTS_REFERENCE_DISALLOWED_PATHS.join(', ')})`);
