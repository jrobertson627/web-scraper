import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { createQueryService, createApiServer } from '../src/api/index.mjs';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createPageRequest, decodePageCursor, encodePageCursor, MAX_PAGE_LIMIT } from '../src/contracts/boundaries.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

async function withServer(server, action) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// Counts every persistence call the query service makes.
function recording(persistence) {
  const calls = [];
  const proxy = new Proxy(persistence, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args) => { calls.push(name); return value.apply(target, args); };
    },
  });
  return { proxy, calls };
}

async function ingested() {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus() });
  await app.runWorkerOnce();
  return app;
}

test('list routes page with limit and an opaque cursor advertised in a Link header', async () => {
  const app = await ingested();
  await withServer(app.createApiServer(), async (base) => {
    for (const [route, total] of [['/games', 6], ['/schools', 3], ['/seasons', (await app.queries.listSeasons()).items.length]]) {
      const seen = [];
      let next = `${route}?limit=2`;
      let pages = 0;
      while (next) {
        const response = await fetch(`${base}${next}`);
        assert.equal(response.status, 200);
        const items = await response.json();
        assert.ok(Array.isArray(items) && items.length <= 2);
        seen.push(...items);
        pages += 1;
        const link = response.headers.get('link');
        next = link ? /^<([^>]+)>; rel="next"$/.exec(link)[1] : null;
        if (next) assert.equal(new URL(next, base).searchParams.get('cursor'), response.headers.get('x-next-cursor'));
      }
      assert.equal(seen.length, total, route);
      assert.equal(pages, Math.max(1, Math.ceil(total / 2)), route);
      const whole = await fetch(`${base}${route}`).then((response) => response.json());
      assert.deepEqual(seen, whole, `${route} pages concatenate to the default listing`);
    }
    assert.equal((await fetch(`${base}/games`)).headers.get('link'), null);
  });
});

test('invalid paging parameters are rejected with 400', async () => {
  const app = await ingested();
  const { proxy, calls } = recording(app.persistence);
  await withServer(createApiServer({ queries: createQueryService(proxy), config: { publication: 'private' } }), async (base) => {
    for (const query of ['limit=0', `limit=${MAX_PAGE_LIMIT + 1}`, 'limit=abc', 'limit=1.5', 'cursor=not-a-cursor',
      `cursor=${encodePageCursor([1, 2])}`]) {
      const response = await fetch(`${base}/games?${query}`);
      assert.equal(response.status, 400, query);
      assert.match((await response.json()).error, /limit is invalid|cursor is invalid/);
    }
  });
  assert.deepEqual(calls.filter((name) => name.startsWith('list')).length, 2, 'only the two malformed cursors reach the adapter');
});

test('game detail and health use one keyed read each and never load a listing', async () => {
  const app = await ingested();
  const { proxy, calls } = recording(app.persistence);
  const game = (await app.queries.listGames({ limit: 1 })).items[0];
  await withServer(createApiServer({ queries: createQueryService(proxy), config: { publication: 'private' } }), async (base) => {
    const detail = await fetch(`${base}/games/${encodeURIComponent(game.gameKey)}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).gameKey, game.gameKey);
    assert.equal((await fetch(`${base}/games/${encodeURIComponent('fixture-provider:not/a/game')}`)).status, 404);
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.jobStates.parsed, foundationCorpus().length);
    assert.equal(health.conflicts, 0);
  });
  assert.deepEqual(calls, ['getGame', 'getGame', 'health']);
});

test('the in-memory read port is keyed by record identity and frozen', async () => {
  const app = await ingested();
  const [first] = (await app.queries.listGames({ limit: 1 })).items;
  const game = app.persistence.getGame(first.gameKey);
  assert.equal(Object.isFrozen(game), true);
  assert.deepEqual(game, first);
  const schoolIndexKey = app.persistence.listJobs().find((job) => job.pageType === 'school_index').key;
  assert.equal(app.persistence.getGame(schoolIndexKey), null, 'a non-game page is not a game');
  assert.equal(app.persistence.getGame(undefined), null);
});

test('paging requests and cursors are validated in one place', () => {
  assert.deepEqual({ ...createPageRequest() }, { limit: 100, cursor: null });
  assert.deepEqual({ ...createPageRequest({ limit: '25', cursor: 'abc' }) }, { limit: 25, cursor: 'abc' });
  assert.throws(() => createPageRequest({ cursor: 'x'.repeat(4096) }), (error) => error.code === 'invalid_paging');
  const cursor = encodePageCursor(['p', 'host/school/a', 2026]);
  assert.deepEqual(decodePageCursor(cursor, ['string', 'string', 'integer']), ['p', 'host/school/a', 2026]);
  assert.throws(() => decodePageCursor(cursor, ['string', 'string']), /cursor is invalid/);
  assert.throws(() => decodePageCursor(encodePageCursor(['p', 'x', '2026']), ['string', 'string', 'integer']), /cursor is invalid/);
});

test('PostgreSQL reads issue one bounded statement per route', async () => {
  const statements = [];
  const pool = {
    on() {},
    async query(sql, params = []) {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/SHOW|json_object_agg/.test(sql)) {
        return { rowCount: 1, rows: [{ job_states: { parsed: 2 }, source_fetches: 2, parse_runs: 2, warnings: 0,
          unavailable_coverage: 0, conflicts: 1, observations: 3 }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const persistence = new PostgresPersistence({ pool });

  const health = await persistence.health();
  assert.equal(statements.length, 1);
  assert.deepEqual({ ...health.jobStates }, { parsed: 2 });
  assert.doesNotMatch(statements[0].sql, /FROM (schools|school_seasons|games)\b/, 'health loads no entity rows');

  statements.length = 0;
  assert.equal(await persistence.getGame('fixture-provider:fixture.example:8443/box/one.html'), null);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /JOIN games g ON g\.provider_id = k\.provider_id AND g\.canonical_box_score_path = k\.path/);
  assert.deepEqual(statements[0].params, [['fixture-provider', 'fixture-provider:fixture.example'],
    ['fixture.example:8443/box/one.html', '8443/box/one.html']]);
  assert.equal(await persistence.getGame('no-separator'), null);
  assert.equal(statements.length, 1, 'a key without a provider prefix needs no query');

  statements.length = 0;
  const cursor = encodePageCursor(['fixture-provider', 'fixture.example/box/one.html']);
  const page = await persistence.listGames({ limit: 10, cursor });
  assert.deepEqual({ ...page, items: [...page.items] }, { items: [], nextCursor: null });
  assert.match(statements[0].sql, /WHERE \(g\.provider_id,g\.canonical_box_score_path\) > \(\$2,\$3\) ORDER BY g\.provider_id,g\.canonical_box_score_path LIMIT \$1$/);
  assert.deepEqual(statements[0].params, [11, 'fixture-provider', 'fixture.example/box/one.html']);
  await persistence.listSchools({ limit: 5 });
  assert.match(statements[1].sql, /ORDER BY provider_id,canonical_source_path LIMIT \$1$/);
  assert.deepEqual(statements[1].params, [6]);
  await persistence.listSeasons({ limit: 5, cursor: encodePageCursor(['p', 'host/school/a', 2026]) });
  assert.deepEqual(statements[2].params, [6, 'p', 'host/school/a', 2026]);
  await assert.rejects(persistence.listSeasons({ cursor: encodePageCursor(['p', 'host/school/a']) }), /cursor is invalid/);
  assert.equal(statements.length, 3);
});

test('a PostgreSQL page returns a next cursor only when another row exists', async () => {
  const rows = [1, 2, 3].map((n) => ({ provider_id: 'p', canonical_box_score_path: `host/box/${n}.html`, data: { n }, provenance: {} }));
  const persistence = new PostgresPersistence({ pool: { on() {}, async query(_sql, params) { return { rowCount: rows.length, rows: rows.slice(0, params[0]) }; } } });
  const first = await persistence.listGames({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.gameKey), ['p:host/box/1.html', 'p:host/box/2.html']);
  assert.deepEqual(decodePageCursor(first.nextCursor, ['string', 'string']), ['p', 'host/box/2.html']);
  assert.equal((await persistence.listGames({ limit: 3 })).nextCursor, null);
});
