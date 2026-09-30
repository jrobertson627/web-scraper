import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DEFAULT_IDLE_HEARTBEAT_MS, exitOrIdle, idleHeartbeatMs, idleOnExitEnabled, idleStateFor, idleUntilStopped } from '../src/application/idle.mjs';
import { REQUEST_POLICY_DEFAULTS } from '../src/contracts/request-policy.mjs';

// #126: a finished or halted worker stays up and idle instead of exiting, which a
// Render Background Worker would restart in a loop.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the states worth waiting in are a finished crawl and the three exits Render would loop on', () => {
  assert.equal(idleStateFor(0).state, 'finished');
  assert.equal(idleStateFor(3).state, 'configuration_rejected');
  assert.equal(idleStateFor(4).state, 'not_ready');
  assert.equal(idleStateFor(6).state, 'halted');
  for (const exitCode of [1, 2, 5, 7]) assert.equal(idleStateFor(exitCode), null, `exit ${exitCode} is not idled: a crash should restart and show up`);
});

test('idling is opt-in, and its heartbeat is validated', () => {
  assert.equal(idleOnExitEnabled({}), false);
  assert.equal(idleOnExitEnabled({ WORKER_IDLE_ON_EXIT: 'false' }), false);
  assert.equal(idleOnExitEnabled({ WORKER_IDLE_ON_EXIT: 'true' }), true);
  assert.equal(idleHeartbeatMs({}), DEFAULT_IDLE_HEARTBEAT_MS);
  assert.equal(idleHeartbeatMs({ WORKER_IDLE_HEARTBEAT_MS: '5000' }), 5000);
  for (const bad of ['soon', '10', '-5', '1.5']) assert.throws(() => idleHeartbeatMs({ WORKER_IDLE_HEARTBEAT_MS: bad }), /invalid WORKER_IDLE_HEARTBEAT_MS/, bad);
});

test('an idle worker logs its state at once and at each heartbeat, and stops on SIGTERM or SIGINT', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const signals = new EventEmitter();
    const lines = [];
    let stopped = false;
    const idle = idleUntilStopped({ exitCode: 6, log: (line) => lines.push(JSON.parse(line)), heartbeatMs: 15, signals, now: () => new Date('2026-01-01T00:00:00Z') })
      .then(() => { stopped = true; });
    await wait(80);
    assert.equal(stopped, false, 'it stays up until told to stop');
    assert.ok(lines.length >= 3, `logged ${lines.length} lines: once, then per heartbeat`);
    assert.deepEqual(lines[0], { at: '2026-01-01T00:00:00.000Z', event: 'worker.idle', severity: 'error', state: 'halted', exitCode: 6, message: lines[0].message });
    assert.match(lines[0].message, /npm run review/);
    signals.emit(signal);
    await idle;
    assert.equal(stopped, true);
    const logged = lines.length;
    await wait(50);
    assert.equal(lines.length, logged, 'no heartbeat after it stopped');
    assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0, 'its signal handlers are removed');
  }
});

test('a finished crawl idles as information, not an error', async () => {
  const signals = new EventEmitter();
  const lines = [];
  const idle = idleUntilStopped({ exitCode: 0, log: (line) => lines.push(JSON.parse(line)), heartbeatMs: 1000, signals });
  signals.emit('SIGTERM');
  await idle;
  assert.deepEqual([lines[0].state, lines[0].severity], ['finished', 'info']);
});

test('the entrypoint exits with the run\'s code unless it is a worker set to idle in an idle-worthy state', async () => {
  const flag = { WORKER_IDLE_ON_EXIT: 'true', WORKER_IDLE_HEARTBEAT_MS: '1000' };
  const never = { once() { throw new Error('must not wait'); }, off() {} };
  assert.equal(await exitOrIdle({ mode: 'worker', exitCode: 0, env: {}, signals: never }), 0, 'not enabled');
  assert.equal(await exitOrIdle({ mode: 'worker', exitCode: 3, env: {}, signals: never }), 3, 'not enabled: the code is kept');
  assert.equal(await exitOrIdle({ mode: 'reprocess', exitCode: 0, env: flag, signals: never }), 0, 'only worker mode idles');
  assert.equal(await exitOrIdle({ mode: 'review', exitCode: 3, env: flag, signals: never }), 3);
  assert.equal(await exitOrIdle({ mode: 'worker', exitCode: 1, env: flag, signals: never }), 1, 'a crash still exits, so it restarts');
  assert.equal(await exitOrIdle({ mode: 'worker', exitCode: 5, env: flag, signals: never }), 5);

  const signals = new EventEmitter();
  const lines = [];
  const pending = exitOrIdle({ mode: 'worker', exitCode: 6, env: flag, log: (line) => lines.push(line), signals });
  await wait(20);
  signals.emit('SIGTERM');
  assert.equal(await pending, 0, 'stopping an idle worker is a clean exit');
  assert.equal(JSON.parse(lines[0]).state, 'halted');
});

// The real entrypoints, in a child process with no database or credentials, so the run
// ends in a rejected configuration (exit 3) straight away.
function runWorker(script, extraEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:PG|USER_AGENT|RAW_STORE|PERSISTENCE|OPERATOR|CRAWL_|WORKER_)/.test(name)));
  const child = spawn(process.execPath, script, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const state = { stderr: '', exited: null };
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  child.on('exit', (code) => { state.exited = code; });
  return { child, state };
}

for (const [label, script] of [['npm run start:worker:personal', ['scripts/personal-worker.mjs']], ['the worker CLI', ['src/application/cli.mjs', 'worker']]]) {
  test(`${label}: without WORKER_IDLE_ON_EXIT a rejected configuration exits 3`, async () => {
    const { state } = runWorker(script, {});
    for (let waited = 0; state.exited === null && waited < 8000; waited += 50) await wait(50);
    assert.equal(state.exited, 3);
  });

  test(`${label}: with WORKER_IDLE_ON_EXIT a rejected configuration idles, logging its state, instead of exiting`, async (t) => {
    const { child, state } = runWorker(script, { WORKER_IDLE_ON_EXIT: 'true', WORKER_IDLE_HEARTBEAT_MS: '1000' });
    t.after(() => child.kill());
    for (let waited = 0; !state.stderr.includes('worker.idle') && state.exited === null && waited < 8000; waited += 50) await wait(50);
    assert.equal(state.exited, null, `still running (stderr: ${state.stderr.slice(-200)})`);
    const line = state.stderr.split('\n').find((entry) => entry.includes('worker.idle'));
    assert.deepEqual([JSON.parse(line).state, JSON.parse(line).exitCode, JSON.parse(line).severity], ['configuration_rejected', 3, 'error']);
    await wait(1300);
    assert.ok(state.stderr.split('\n').filter((entry) => entry.includes('worker.idle')).length >= 2, 'it logs a heartbeat');
    assert.equal(state.exited, null);
  });
}

test('the Render blueprint idles the worker and gives it time to finish a request on shutdown', () => {
  const blueprint = readFileSync('render.yaml', 'utf8').replaceAll('\r\n', '\n');
  assert.match(blueprint, /- key: WORKER_IDLE_ON_EXIT\n\s+value: "true"/);
  const grace = Number(/maxShutdownDelaySeconds:\s*(\d+)/.exec(blueprint)?.[1]);
  assert.ok(grace * 1000 > REQUEST_POLICY_DEFAULTS.requestTimeoutMs * 2, `${grace} s covers the ${REQUEST_POLICY_DEFAULTS.requestTimeoutMs / 1000} s request timeout plus commit time`);
  assert.ok(grace <= 300, 'within what Render allows');
});
