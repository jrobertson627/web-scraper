// Runs the orchestrator as a long-running worker until no runnable work
// remains, or until SIGTERM/SIGINT asks it to stop. On a signal the worker
// stops claiming, lets the current job settle (a request already on the wire
// finishes, a request not yet started is skipped, and the host is released),
// then returns counts. A second signal is ignored; the platform's kill timeout
// still applies.
export async function runWorkerLoop({ orchestrator, workerId = 'worker', signals = process, log = () => {}, ...options }) {
  const controller = new AbortController();
  const handlers = ['SIGTERM', 'SIGINT'].map((name) => [name, () => {
    if (!controller.signal.aborted) log(`worker received ${name}; finishing the current job before exiting`);
    controller.abort();
  }]);
  for (const [name, handler] of handlers) signals.on(name, handler);
  try {
    return await orchestrator.run({ ...options, workerId, signal: controller.signal });
  } finally {
    for (const [name, handler] of handlers) signals.off(name, handler);
  }
}
