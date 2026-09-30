// Keeps the worker process alive after it has nothing more to do (#126).
//
// Render restarts a Background Worker whenever its process exits. The worker
// exits 0 when no runnable work remains, so a finished crawl restarted, found
// nothing to do and exited again, indefinitely; exits 3, 4 and 6 (a rejected
// configuration, a missing parser, a halt awaiting review) looped the same way,
// each restart reconnecting to the database. With WORKER_IDLE_ON_EXIT=true the
// worker instead logs its state and stays up, doing nothing, until SIGTERM or
// SIGINT. Resuming after a fix or a review is then a restart or a redeploy of
// the service, which is the deliberate step it should be.
//
// It is opt-in and only for worker mode, so a local run, a test or a script that
// waits on the exit code still gets it. An unexpected failure (exit 1) still
// exits, so a crash restarts and shows up as one.

const IDLE_STATES = new Map([
  [0, { state: 'finished', severity: 'info', message: 'no runnable work remains' }],
  [3, { state: 'configuration_rejected', severity: 'error', message: 'the configuration was rejected; fix it and restart the service' }],
  [4, { state: 'not_ready', severity: 'error', message: 'a configured production parser is missing; deploy it and restart the service' }],
  [6, { state: 'halted', severity: 'error', message: 'the crawl halted and awaits review; npm run review -- list, release the stop or halt, then restart the service' }],
]);

export const DEFAULT_IDLE_HEARTBEAT_MS = 30 * 60_000;

export function idleOnExitEnabled(env) { return env?.WORKER_IDLE_ON_EXIT === 'true'; }

// The idle state for an exit code, or null when the process should just exit.
export function idleStateFor(exitCode) { return IDLE_STATES.get(exitCode) ?? null; }

export function idleHeartbeatMs(env) {
  const value = env?.WORKER_IDLE_HEARTBEAT_MS;
  if (value === undefined || value === '') return DEFAULT_IDLE_HEARTBEAT_MS;
  if (!/^\d{4,9}$/.test(value)) throw new Error('invalid WORKER_IDLE_HEARTBEAT_MS. Expected milliseconds, at least 1000. Example: WORKER_IDLE_HEARTBEAT_MS=1800000');
  return Number(value);
}

// Logs the state now and at every heartbeat, and resolves when the process is
// asked to stop. `signals` is the process, or anything with once/off.
export function idleUntilStopped({ exitCode, log, heartbeatMs, signals = process, now = () => new Date() }) {
  const idle = idleStateFor(exitCode);
  return new Promise((resolve) => {
    const line = () => log(JSON.stringify({ at: now().toISOString(), event: 'worker.idle', severity: idle.severity, state: idle.state, exitCode, message: idle.message }));
    line();
    const timer = setInterval(line, heartbeatMs);
    const stop = () => {
      clearInterval(timer);
      signals.off('SIGTERM', stop);
      signals.off('SIGINT', stop);
      resolve();
    };
    signals.once('SIGTERM', stop);
    signals.once('SIGINT', stop);
  });
}

// What the entrypoint exits with: the run's own exit code, or, when it is set to
// idle and the run ended in a state worth waiting in, 0 after a stop signal.
export async function exitOrIdle({ mode, exitCode, env = process.env, log = (message) => console.error(message), signals = process }) {
  if (mode !== 'worker' || !idleOnExitEnabled(env) || !idleStateFor(exitCode)) return exitCode;
  await idleUntilStopped({ exitCode, log, heartbeatMs: idleHeartbeatMs(env), signals });
  return 0;
}
