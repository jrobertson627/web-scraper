import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

// The PIN-protected operator trigger (#55): start, check and stop a crawl run
// from a phone. It is its own server and route group, separate from the
// read-only API (src/api), which never imports it and cannot reach a run.
//
// Routes:
//   GET  /operator          the page: a PIN field and Start, Status and Stop buttons
//   POST /operator/trigger  start (or resume) a run unless one is active
//   POST /operator/status   crawl progress, and whether a run is active here
//   POST /operator/stop     ask the active run to stop after its current job
// Every POST needs the PIN, as a form field or JSON `pin`, or an
// `x-operator-pin` header. Anything else is 404 or 405.
//
// A run is refused while this process runs one, and while any job holds a live
// claim: that is another worker's run, judged by the job leases themselves
// (JOB_LIFECYCLE.md). Leases and host request locks keep two runs from ever
// overlapping requests even if both started; this check keeps a second one
// from starting.

export const MIN_PIN_LENGTH = 8;
const MAX_BODY_BYTES = 2048;

function digest(value) { return createHash('sha256').update(String(value)).digest(); }

// Constant-time comparison of equal-length digests, so neither the PIN's
// length nor a matching prefix is timed.
export function pinMatches(expected, supplied) {
  return typeof supplied === 'string' && supplied.length > 0 && timingSafeEqual(digest(expected), digest(supplied));
}

export function assertOperatorPin(pin) {
  if (typeof pin !== 'string' || pin.length < MIN_PIN_LENGTH || pin !== pin.trim()) {
    throw new Error(`OPERATOR_PIN is missing or too short. Expected at least ${MIN_PIN_LENGTH} characters without surrounding spaces, set as a secret. Example: OPERATOR_PIN=<a long random value>`);
  }
  return pin;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function page({ message = '', detail = null } = {}) {
  const form = (action, label) => `<form method="post" action="/operator/${action}"><input type="password" name="pin" autocomplete="current-password" inputmode="text" aria-label="PIN" placeholder="PIN" required><button type="submit">${label}</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crawl operator</title><style>
body{font:16px/1.4 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:28rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input,button{color:inherit;background:#222;border-color:#555}}
form{display:flex;gap:8px;margin:12px 0}input{flex:1;font:inherit;padding:10px;border:1px solid #888;border-radius:6px;min-width:0}
button{font:inherit;padding:10px 14px;border:1px solid #888;border-radius:6px;cursor:pointer}
.message{padding:10px;border-radius:6px;background:rgba(127,127,127,.15)}pre{white-space:pre-wrap;word-break:break-word;font-size:13px}
</style></head><body><h1>Crawl operator</h1>
${message ? `<p class="message" role="status">${escapeHtml(message)}</p>` : ''}
${form('trigger', 'Start or resume')}${form('status', 'Status')}${form('stop', 'Stop')}
${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}</body></html>`;
}

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!text) return {};
  if (type === 'application/json') {
    try { return JSON.parse(text) ?? {}; } catch { throw Object.assign(new Error('request body is not valid JSON'), { status: 400 }); }
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  throw Object.assign(new Error('unsupported content type'), { status: 415 });
}

// startRun(signal) starts a run and returns a promise of its result; status()
// returns a progress summary; liveClaims() counts jobs holding a live claim.
// failures within lockoutMs of each other, maxFailures of them, lock every PIN
// check for lockoutMs, so a short PIN cannot be guessed; a lockout also delays
// the operator, which is the trade-off.
export function createOperatorServer({
  pin, startRun, status, liveClaims, clock = () => new Date(), maxFailures = 5, lockoutMs = 15 * 60_000,
  onRunSettled = () => {},
}) {
  const operatorPin = assertOperatorPin(pin);
  let failures = [];
  let lockedUntil = 0;
  let current = null;
  let last = null;

  const now = () => clock().getTime();
  function authorized(supplied) {
    if (now() < lockedUntil) return { ok: false, status: 429, message: 'Too many wrong PINs. Try again later.' };
    if (pinMatches(operatorPin, supplied)) { failures = []; return { ok: true }; }
    failures = [...failures.filter((at) => now() - at < lockoutMs), now()];
    if (failures.length >= maxFailures) { lockedUntil = now() + lockoutMs; failures = []; }
    return { ok: false, status: 401, message: 'Wrong PIN.' };
  }

  async function trigger() {
    if (current) return { status: 409, message: `A run started here at ${current.startedAt} is still active.` };
    const claims = await liveClaims();
    if (claims > 0) return { status: 409, message: `Another worker holds ${claims} live claim${claims === 1 ? '' : 's'}; not starting a second run.` };
    const controller = new AbortController();
    const startedAt = clock().toISOString();
    const run = { startedAt, controller, promise: null };
    current = run;
    run.promise = Promise.resolve().then(() => startRun(controller.signal)).then(
      (result) => { last = { startedAt, finishedAt: clock().toISOString(), outcome: 'finished', result }; },
      (error) => { last = { startedAt, finishedAt: clock().toISOString(), outcome: 'failed', error: error?.message ?? String(error) }; },
    ).finally(() => { if (current === run) current = null; onRunSettled(last); });
    return { status: 202, message: `Run started at ${startedAt}.` };
  }

  async function report() {
    const summary = await status();
    return { status: 200, message: current ? `A run started at ${current.startedAt} is active.` : 'No run is active here.',
      detail: { active: Boolean(current), last, summary } };
  }

  function stop() {
    if (!current) return { status: 409, message: 'No run is active here.' };
    current.controller.abort();
    return { status: 202, message: 'Stopping after the current job.' };
  }

  const actions = { trigger, status: report, stop };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/$/, '') || '/';
    const wantsJson = String(request.headers.accept ?? '').includes('application/json')
      || String(request.headers['content-type'] ?? '').startsWith('application/json');
    const send = (statusCode, { message = '', detail = null } = {}) => {
      if (wantsJson) {
        response.writeHead(statusCode, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message, ...(detail ? { detail } : {}) }));
      } else {
        response.writeHead(statusCode, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
        response.end(page({ message, detail: detail ? JSON.stringify(detail, null, 2) : null }));
      }
    };
    try {
      if (path === '/operator') {
        if (request.method !== 'GET') { response.setHeader('allow', 'GET'); send(405, { message: 'Method not allowed.' }); return; }
        send(200);
        return;
      }
      const action = path.startsWith('/operator/') ? actions[path.slice('/operator/'.length)] : undefined;
      if (!action) { send(404, { message: 'Not found.' }); return; }
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); send(405, { message: 'Method not allowed.' }); return; }
      const body = await readBody(request);
      const check = authorized(request.headers['x-operator-pin'] ?? body.pin);
      if (!check.ok) { send(check.status, { message: check.message }); return; }
      const result = await action();
      send(result.status, result);
    } catch (error) {
      send(error?.status ?? 500, { message: error?.status ? error.message : 'The operator request failed.' });
    }
  });

  return Object.freeze({
    server,
    // Stops an active run (it finishes its current job) and resolves when it settles.
    async shutdown() {
      const run = current;
      if (!run) return;
      run.controller.abort();
      await run.promise;
    },
    active: () => Boolean(current),
  });
}
