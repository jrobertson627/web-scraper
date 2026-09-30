// CI check for a pull request (#123): a change to the parsers, the documents they
// build, or the capture manifest must carry the "Real-capture verification" line
// `npm run parsers:verify` prints, naming this change's parser code and the
// committed capture set. Reads PR_BODY, BASE_SHA and HEAD_SHA from the environment
// (the description is passed as an environment variable, never spliced into a
// command). Exit 0: not needed, or the evidence matches. Exit 1: it is missing or
// stale. It reads git only; it never runs the parsers, which need captures CI
// does not have.
import { execFileSync } from 'node:child_process';
import {
  PARSER_CONTRACT_FILES, PARSER_DIRECTORY, captureSetId, checkEvidence, needsEvidence, parserCodeId,
} from './parser-evidence.mjs';

const { PR_BODY = '', BASE_SHA, HEAD_SHA } = process.env;
if (!BASE_SHA || !HEAD_SHA) {
  console.error('BASE_SHA and HEAD_SHA are required');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const changed = git('diff', '--name-only', `${BASE_SHA}...${HEAD_SHA}`).split('\n').filter(Boolean);
if (!needsEvidence(changed)) {
  console.log('No parser, parsed-document or capture-manifest change: real-capture evidence is not needed.');
  process.exit(0);
}

const files = [
  ...git('ls-tree', '-r', '--name-only', HEAD_SHA, '--', PARSER_DIRECTORY).split('\n').filter((file) => file.endsWith('.mjs')),
  ...PARSER_CONTRACT_FILES,
];
const parsers = parserCodeId(files, (file) => git('show', `${HEAD_SHA}:${file}`));
const captures = captureSetId(JSON.parse(git('show', `${HEAD_SHA}:fixtures/sports-reference/manifest.json`)));
const result = checkEvidence(PR_BODY, { captures, parsers });
console.log(result.ok ? result.message : `::error::${result.message}`);
if (!result.ok) console.log(`Expected: captures ${captures}, parsers ${parsers}. Changed: ${changed.filter((file) => needsEvidence([file])).join(', ')}`);
process.exit(result.ok ? 0 : 1);
