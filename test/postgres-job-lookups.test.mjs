import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresPersistence, jobKeyParts } from '../src/persistence/postgres.mjs';
import { createJob } from '../src/contracts/boundaries.mjs';
import { createLeaseToken } from '../src/contracts/jobs.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';

// A pool that records every statement and answers with one leased job row, so
// the SQL the adapter sends can be inspected without a database.
function recordingPool(respond = () => null) {
  const statements = [];
  const row = { id: '7', provider_id: 'provider', canonical_path: 'allowed.example/page', page_type: 'season',
    source_url: 'https://allowed.example/page', parser_version: '1', state: 'fetching', attempts: 1,
    claim_generation: '1', lease_generation: '1', claim_owner: 'worker', claim_expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(), updated_at: new Date() };
  const query = async (text, values = []) => {
    statements.push({ text, values });
    const custom = respond(text, values, row);
    if (custom) return custom;
    if (/in_flight_requests/.test(text) && /^\s*SELECT/.test(text)) return { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [{ ...row }], rowCount: 1 };
  };
  return { statements, query, connect: async () => ({ query, release() {} }), end: async () => {} };
}

test('job keys split back into the three indexed crawl_jobs columns', () => {
  assert.deepEqual(jobKeyParts('provider:allowed.example/a:b?x=1:season'), ['provider', 'allowed.example/a:b?x=1', 'season']);
  assert.deepEqual(jobKeyParts('provider:allowed.example:8443/page:box_score'), ['provider', 'allowed.example:8443/page', 'box_score']);
  for (const malformed of ['', 'no-delimiters', ':path:season', 'provider:path:', 'provider::season', undefined]) {
    assert.deepEqual(jobKeyParts(malformed), [null, null, null], String(malformed));
  }
  const sourceUrl = createSourceUrl('bad:provider', 'https://allowed.example/page');
  assert.throws(() => createJob({ key: 'k', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }), /must not contain ":"/);
});

test('lease checks, renewals, transitions and fetch records look jobs up by indexed columns, never by a concatenated key', async () => {
  const pool = recordingPool();
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
  const key = 'provider:allowed.example/page:season';
  const lease = createLeaseToken('worker', 1);
  await persistence.renewClaim(key, lease);
  await persistence.transitionJob(key, 'fetched', lease);
  await persistence.recordFetch({ jobKey: key, status: 404 }, lease);
  await persistence.getJob(key);
  await persistence.lastSuccessfulFetch(key);
  await persistence.releaseRequest(key, lease);
  const lookups = pool.statements.filter(({ text }) => /FROM crawl_jobs|UPDATE crawl_jobs/.test(text) && /page_type|WHERE/.test(text));
  assert.ok(lookups.length >= 6);
  for (const { text, values } of pool.statements) {
    assert.doesNotMatch(text, /\|\|\s*':'\s*\|\|[^\n]*=\s*\$/, text);
    if (/provider_id = \$/.test(text)) {
      assert.ok(values.includes('provider') && values.includes('allowed.example/page') && values.includes('season'), text);
    }
  }
});
