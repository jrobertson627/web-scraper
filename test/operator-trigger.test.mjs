import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { EXIT_CODES, runCli } from '../src/application/cli.mjs';
import { MIN_PIN_LENGTH, assertOperatorPin, clientKey, clientOf, createOperatorServer, pinMatches } from '../src/application/operator-server.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';

const PIN = 'correct horse battery';

// An operator server on a loopback port, with a controllable clock and runs.
async function operator(options = {}) {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const runs = [];
  const settled = [];
  const server = createOperatorServer({
    pin: PIN, clock: () => new Date(time), liveClaims: async () => options.liveClaims ?? 0,
    status: async () => ({ totals: { done: 3, remaining: 1 } }), onRunSettled: (last) => settled.push(last),
    startRun: (signal) => new Promise((resolve) => {
      const run = { signal, finish: (result = { processed: 1 }) => resolve(result) };
      signal.addEventListener('abort', () => resolve({ processed: 0, stopped: true }), { once: true });
      runs.push(run);
    }),
    ...options.server,
  });
  server.server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const post = (action, pin, { json = false, headers = {} } = {}) => fetch(`${base}/operator/${action}`, {
    method: 'POST',
    headers: json ? { 'content-type': 'application/json', accept: 'application/json', ...headers } : { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: pin === undefined ? '' : json ? JSON.stringify({ pin }) : new URLSearchParams({ pin }).toString(),
  });
  return { server, base, runs, settled, post, advance: (ms) => { time += ms; }, close: () => new Promise((resolve) => server.server.close(resolve)) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the PIN must be a long secret and is compared without shortcuts', () => {
  assert.throws(() => assertOperatorPin(undefined), /OPERATOR_PIN is missing or too short/);
  assert.throws(() => assertOperatorPin('1234567'), new RegExp(`at least ${MIN_PIN_LENGTH} characters`));
  assert.throws(() => assertOperatorPin(' spaced pin '), /without surrounding spaces/);
  assert.equal(assertOperatorPin(PIN), PIN);
  assert.equal(pinMatches(PIN, PIN), true);
  assert.equal(pinMatches(PIN, `${PIN}x`), false);
  assert.equal(pinMatches(PIN, PIN.slice(0, -1)), false);
  assert.equal(pinMatches(PIN, ''), false);
  assert.equal(pinMatches(PIN, undefined), false);
  assert.throws(() => createOperatorServer({ pin: 'short', startRun() {}, status() {}, liveClaims() {} }), /OPERATOR_PIN/);
});

test('the page is a phone-sized form with strict headers, and no route runs without the right PIN', async (t) => {
  const run = await operator();
  t.after(run.close);
  const page = await fetch(`${run.base}/operator`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  for (const action of ['trigger', 'status', 'stop']) assert.match(html, new RegExp(`action="/operator/${action}"`));
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  const wrong = await run.post('trigger', 'not the pin at all');
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), /not the pin at all|correct horse/);
  assert.equal((await run.post('trigger', undefined)).status, 401);
  assert.equal((await run.post('status', 'nope nope nope')).status, 401);
  assert.equal(run.runs.length, 0, 'the orchestrator is never reached without the PIN');
  assert.equal((await fetch(`${run.base}/operator/trigger`)).status, 405);
  assert.equal((await fetch(`${run.base}/operator`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${run.base}/schools`)).status, 404);
  assert.equal((await fetch(`${run.base}/operator/delete-everything`, { method: 'POST' })).status, 404);
});

test('a trigger starts one run; another is refused until it settles, and stop asks it to finish', async (t) => {
  const run = await operator();
  t.after(run.close);
  const started = await run.post('trigger', PIN);
  assert.equal(started.status, 202);
  assert.match(await started.text(), /Run started at 2026-01-01T00:00:00.000Z/);
  await settle();
  assert.equal(run.runs.length, 1);
  assert.equal((await run.post('trigger', PIN)).status, 409, 'a second run is not started');
  assert.equal(run.runs.length, 1);

  const status = await run.post('status', PIN, { json: true });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).detail, { active: true, last: null, challengesAwaitingReview: [], summary: { totals: { done: 3, remaining: 1 } } });

  const stopped = await run.post('stop', PIN, { json: true });
  assert.equal(stopped.status, 202);
  assert.equal(run.runs[0].signal.aborted, true);
  await settle();
  await settle();
  assert.equal(run.settled.at(-1).outcome, 'finished');
  assert.deepEqual(run.settled.at(-1).result, { processed: 0, stopped: true });
  assert.equal((await run.post('stop', PIN)).status, 409, 'nothing left to stop');
  assert.equal((await run.post('trigger', PIN, { headers: { 'x-operator-pin': PIN } })).status, 202, 'a new run may start once the last settled');
  await settle();
  run.runs[1].finish();
  await run.server.shutdown();
});

test('a trigger is refused while another worker holds live claims', async (t) => {
  const run = await operator({ liveClaims: 2 });
  t.after(run.close);
  const refused = await run.post('trigger', PIN, { json: true });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /Another worker holds 2 live claims/);
  assert.equal(run.runs.length, 0);
});

test('repeated wrong PINs lock every PIN check for the lockout period', async (t) => {
  const run = await operator({ server: { maxFailures: 3, lockoutMs: 60_000 } });
  t.after(run.close);
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await run.post('status', `wrong guess ${attempt}`)).status, 401);
  assert.equal((await run.post('status', PIN)).status, 429, 'even the right PIN waits out the lockout');
  run.advance(60_001);
  assert.equal((await run.post('status', PIN)).status, 200);
  // Failures spread wider than the window do not add up.
  for (let attempt = 0; attempt < 2; attempt += 1) { await run.post('status', 'wrong guess'); run.advance(61_000); }
  assert.equal((await run.post('status', PIN)).status, 200);
});

test('bodies are small and typed', async (t) => {
  const run = await operator();
  t.after(run.close);
  const huge = await fetch(`${run.base}/operator/trigger`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `pin=${'x'.repeat(5000)}` });
  assert.equal(huge.status, 413);
  const text = await fetch(`${run.base}/operator/trigger`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: PIN });
  assert.equal(text.status, 415);
  const broken = await fetch(`${run.base}/operator/trigger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":' });
  assert.equal(broken.status, 400);
  assert.equal(run.runs.length, 0);
});

test('the read-only API has no operator route and never imports the trigger', async (t) => {
  const app = createFixtureApplication();
  await app.runWorkerOnce();
  const api = app.createApiServer();
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const base = `http://127.0.0.1:${api.address().port}`;
  assert.equal((await fetch(`${base}/operator`)).status, 404);
  assert.equal((await fetch(`${base}/operator/trigger`, { method: 'POST', body: `pin=${PIN}` })).status, 405);
  for (const file of readdirSync('src/api')) {
    const source = readFileSync(`src/api/${file}`, 'utf8');
    assert.doesNotMatch(source, /operator-server|orchestrator|production-worker|composition-root/, file);
  }
  const operatorSource = readFileSync('src/application/operator-server.mjs', 'utf8');
  assert.deepEqual([...operatorSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]), ['node:crypto', 'node:http', 'node:net']);
});

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('operator mode needs a PIN and PostgreSQL, and runs the production worker on a trigger', async () => {
  const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
  const authorization = record('authorization');
  const env = {
    PROVIDER_ID: authorization.providerId, PROVIDER_HOST: authorization.scope.allowedHosts[0], USER_AGENT: 'test (+ops@example.com)',
    RAW_STORE_ROOT: process.cwd(), AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(record('data-contract')),
    PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET', OPERATOR_PIN: PIN,
  };
  const errors = [];
  const output = [];
  const store = new InMemoryPersistence();
  store.close = async () => { store.closed = (store.closed ?? 0) + 1; };
  const workers = [];
  const run = (overrides) => runCli({ mode: 'operator', env: { ...env, ...overrides }, stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    crawlLog: { emit() {}, summary() {} }, openPostgres: async () => store,
    startWorker: async (context) => {
      workers.push(context);
      return { workerId: 'operator-test', close: async () => {}, orchestrator: { run: async ({ signal }) => ({ processed: 0, stopped: signal.aborted, counts: {} }) } };
    } });

  assert.equal((await run({ OPERATOR_PIN: '' })).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /OPERATOR_PIN is missing or too short/);
  assert.equal((await run({ PERSISTENCE: 'memory' })).exitCode, EXIT_CODES.configurationRejected);

  const port = await availablePort();
  const started = await run({ PORT: String(port) });
  try {
    assert.equal(started.exitCode, EXIT_CODES.success);
    assert.match(output.at(-1), new RegExp(`operator trigger ready on http://127.0.0.1:${port}`));
    const response = await fetch(`http://127.0.0.1:${port}/operator/trigger`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ pin: PIN }) });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workers.length, 1);
    assert.equal(workers[0].config.mode, 'worker', 'the trigger passes the same validated worker configuration');
  } finally {
    await started.close();
  }
  assert.equal(store.closed, 1);
  assert.doesNotMatch(`${errors.join(' ')} ${output.join(' ')}`, /TOP_SECRET|correct horse/);
});

// #125: wrong PINs are counted per client address.
const from = (address) => ({ headers: { 'x-forwarded-for': address } });

test('client keys collapse IPv4-mapped addresses and IPv6 /64 prefixes, and reject non-addresses', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:DB8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  for (const bad of ['not an address', '', undefined, '999.1.1.1']) assert.equal(clientKey(bad), null, String(bad));
});

test('the client is the X-Forwarded-For entry the proxy appended, never an earlier one', () => {
  const request = (forwarded, remoteAddress = '10.0.0.9') => ({ headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }, socket: { remoteAddress } });
  assert.equal(clientOf(request('203.0.113.1'), 1), '203.0.113.1');
  assert.equal(clientOf(request('9.9.9.9, 203.0.113.1'), 1), '203.0.113.1', 'a client-supplied first entry is ignored');
  assert.equal(clientOf(request('9.9.9.9, 203.0.113.1, 10.1.1.1'), 2), '203.0.113.1');
  assert.equal(clientOf(request(undefined), 1), '10.0.0.9', 'no header: the peer address');
  assert.equal(clientOf(request('203.0.113.1'), 0), '10.0.0.9', 'not behind a proxy: the header is ignored');
  assert.equal(clientOf(request('203.0.113.1'), 2), '10.0.0.9', 'fewer entries than trusted hops: the header is not trusted');
  assert.equal(clientOf(request('garbage'), 1), '10.0.0.9', 'an unparseable entry falls back to the peer address');
  assert.equal(clientOf({ headers: {}, socket: {} }, 1), 'unknown');
});

test('wrong PINs from one address lock out that address only', async (t) => {
  const run = await operator({ server: { maxFailures: 3, lockoutMs: 60_000 } });
  t.after(run.close);
  const as = (address) => ({ headers: { 'x-forwarded-for': address } });
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await run.post('status', `wrong guess ${attempt}`, as('203.0.113.1'))).status, 401);
  assert.equal((await run.post('status', PIN, as('203.0.113.1'))).status, 429, 'the guessing address is locked out, even with the right PIN');
  assert.equal((await run.post('status', PIN, as('203.0.113.2'))).status, 200, 'another address is not');
  // Rotating a client-supplied first entry does not escape the lockout: the proxy's entry counts.
  assert.equal((await run.post('status', PIN, as('198.51.100.9, 203.0.113.1'))).status, 429);
  run.advance(60_001);
  assert.equal((await run.post('status', PIN, as('203.0.113.1'))).status, 200);
});

test('failures from many addresses still add up to a global lockout', async (t) => {
  const run = await operator({ server: { maxFailures: 3, globalMaxFailures: 6, lockoutMs: 60_000 } });
  t.after(run.close);
  const as = (address) => ({ headers: { 'x-forwarded-for': address } });
  for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await run.post('status', 'wrong guess', as(address))).status, 401);
  }
  assert.equal((await run.post('status', PIN, as('203.0.113.4'))).status, 429, 'the global limit locks every address, including a new one');
  assert.equal((await run.post('status', PIN, as('203.0.113.1'))).status, 429);
  run.advance(60_001);
  assert.equal((await run.post('status', PIN, as('203.0.113.4'))).status, 200);
});

test('a right PIN clears only that address, and the failure window is per address', async (t) => {
  const run = await operator({ server: { maxFailures: 3, lockoutMs: 60_000 } });
  t.after(run.close);
  const as = (address) => ({ headers: { 'x-forwarded-for': address } });
  await run.post('status', 'wrong guess', as('203.0.113.1'));
  await run.post('status', 'wrong guess', as('203.0.113.1'));
  assert.equal((await run.post('status', PIN, as('203.0.113.1'))).status, 200);
  for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await run.post('status', 'wrong guess', as('203.0.113.1'))).status, 401, 'the count restarted');
  run.advance(61_000);
  assert.equal((await run.post('status', 'wrong guess', as('203.0.113.1'))).status, 401, 'old failures fell out of the window');
  assert.equal((await run.post('status', PIN, as('203.0.113.1'))).status, 200);
});

test('the header is ignored when no proxy is trusted, and remembered addresses are bounded', async (t) => {
  const direct = await operator({ server: { maxFailures: 2, trustedProxyHops: 0 } });
  t.after(direct.close);
  const as = (address) => ({ headers: { 'x-forwarded-for': address } });
  await direct.post('status', 'wrong guess', as('203.0.113.1'));
  await direct.post('status', 'wrong guess', as('203.0.113.2'));
  assert.equal((await direct.post('status', PIN, as('203.0.113.3'))).status, 429, 'every request is one client, so spoofed headers cannot dodge the count');

  const bounded = await operator({ server: { maxFailures: 2, maxTrackedClients: 2, globalMaxFailures: 50 } });
  t.after(bounded.close);
  for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) await bounded.post('status', 'wrong guess', as(address));
  // The oldest address was forgotten to stay within the bound, so it starts a fresh count.
  assert.equal((await bounded.post('status', 'wrong guess', as('203.0.113.1'))).status, 401);
  assert.equal((await bounded.post('status', PIN, as('203.0.113.1'))).status, 200, 'its earlier failure was forgotten, so one more did not lock it');
});

test('lockout settings are validated', () => {
  const base = { pin: PIN, startRun() {}, status() {}, liveClaims() {} };
  assert.throws(() => createOperatorServer({ ...base, maxFailures: 5, globalMaxFailures: 5 }), /globalMaxFailures/);
  assert.throws(() => createOperatorServer({ ...base, trustedProxyHops: -1 }), /trustedProxyHops/);
});

// #116: the run is reserved before the trigger's database checks, so requests
// that arrive together cannot both start one.
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

test('two simultaneous Start requests start exactly one run; the other gets 409', async (t) => {
  const checks = gate();
  const run = await operator({ server: { liveClaims: async () => { await checks.opened; return 0; } } });
  t.after(run.close);
  const first = run.post('trigger', PIN, { json: true });
  const second = run.post('trigger', PIN, { json: true });
  // Neither request has finished its claim check yet: the reservation alone must decide.
  const early = await Promise.race([first, second]);
  assert.equal(early.status, 409, 'the loser is refused while the winner is still checking');
  checks.open();
  const statuses = [early.status, (await (early === (await first) ? second : first)).status].sort();
  assert.deepEqual(statuses, [202, 409]);
  await settle();
  assert.equal(run.runs.length, 1, 'one run was started');
  assert.equal((await run.post('trigger', PIN)).status, 409);

  // Stop reaches the one run there is, and nothing is left behind for shutdown.
  assert.equal((await run.post('stop', PIN)).status, 202);
  assert.equal(run.runs[0].signal.aborted, true);
  await run.server.shutdown();
  assert.equal(run.server.active(), false);
});

test('a refused or failed trigger gives the reservation back', async (t) => {
  let claims = 1;
  let failure = null;
  const run = await operator({ server: { liveClaims: async () => { if (failure) throw failure; return claims; } } });
  t.after(run.close);
  assert.equal((await run.post('trigger', PIN)).status, 409, 'refused for live claims');
  assert.equal(run.server.active(), false, 'a refusal is not a run');
  failure = new Error('database is unavailable');
  assert.equal((await run.post('trigger', PIN)).status, 500);
  assert.equal(run.server.active(), false, 'a failed check is not a run');
  failure = null;
  claims = 0;
  assert.equal((await run.post('trigger', PIN)).status, 202, 'the next Start works');
  await settle();
  assert.equal(run.runs.length, 1);
  run.runs[0].finish();
  await run.server.shutdown();
});

test('a Stop that arrives while Start is still checking prevents the run from starting', async (t) => {
  const checks = gate();
  const run = await operator({ server: { liveClaims: async () => { await checks.opened; return 0; } } });
  t.after(run.close);
  const starting = run.post('trigger', PIN, { json: true });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await run.post('stop', PIN)).status, 202, 'the reserved run can be stopped');
  checks.open();
  const result = await starting;
  assert.equal(result.status, 409);
  assert.match((await result.json()).message, /stopped before it started/);
  assert.equal(run.runs.length, 0);
  assert.equal(run.server.active(), false);
});

test('shutdown while Start is still checking waits for it and starts nothing', async (t) => {
  const checks = gate();
  const run = await operator({ server: { liveClaims: async () => { await checks.opened; return 0; } } });
  t.after(run.close);
  const starting = run.post('trigger', PIN, { json: true });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const shutdown = run.server.shutdown();
  checks.open();
  await shutdown;
  assert.equal((await starting).status, 409);
  assert.equal(run.runs.length, 0);
});
