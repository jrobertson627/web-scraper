import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

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
// Wrong PINs are counted per client address (#125): a client that guesses wrong
// too often is locked out alone, and another client's PIN still works. A much
// higher global limit still bounds guessing from many addresses. The address is
// the X-Forwarded-For entry the platform's proxy appended (trustedProxyHops
// entries from the end), never an earlier, client-supplied one; without that
// header, or with trustedProxyHops 0, it is the socket's peer address.
//
// A run is refused while this process runs one, and while any job holds a live
// claim: that is another worker's run, judged by the job leases themselves
// (JOB_LIFECYCLE.md). Leases and host request locks keep two runs from ever
// overlapping requests even if both started; this check keeps a second one
// from starting. It is also refused while a challenge stop awaits review: the
// crawl halts on a challenge until an operator has looked (npm run review).

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

// A key for the address a request came from. IPv4-mapped IPv6 becomes IPv4 and
// an IPv6 address is reduced to its /64, since one subscriber holds the whole
// prefix and could otherwise rotate through it. Not an address: null.
export function clientKey(address) {
  const bare = String(address ?? '').trim().replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  const value = mapped ? mapped[1] : bare;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const [head, tail] = value.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = value.includes('::') ? [...front, ...Array(8 - front.length - back.length).fill('0'), ...back] : front;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export function clientOf(request, trustedProxyHops = 1) {
  const entries = String(request.headers?.['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const forwarded = trustedProxyHops > 0 && entries.length >= trustedProxyHops ? clientKey(entries[entries.length - trustedProxyHops]) : null;
  return forwarded ?? clientKey(request.socket?.remoteAddress) ?? 'unknown';
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
// returns a progress summary; liveClaims() counts jobs holding a live claim;
// unreviewedChallenges() lists challenge stops no operator has reviewed.
// maxFailures wrong PINs from one client within lockoutMs lock that client's PIN
// checks for lockoutMs. globalMaxFailures wrong PINs from anyone within
// lockoutMs lock every client's, which is what bounds guessing from many
// addresses; it also delays the operator, so it sits well above maxFailures.
// At most maxTrackedClients addresses are remembered.
export function createOperatorServer({
  pin, startRun, status, liveClaims, unreviewedChallenges = async () => [], clock = () => new Date(), maxFailures = 5, lockoutMs = 15 * 60_000,
  globalMaxFailures = 30, trustedProxyHops = 1, maxTrackedClients = 10_000, onRunSettled = () => {},
}) {
  const operatorPin = assertOperatorPin(pin);
  if (!Number.isSafeInteger(globalMaxFailures) || globalMaxFailures <= maxFailures) throw new Error('globalMaxFailures must be an integer above maxFailures');
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0) throw new Error('trustedProxyHops must be zero or a positive integer');
  const clients = new Map();
  let globalFailures = [];
  let globalLockedUntil = 0;
  let current = null;
  let last = null;

  const now = () => clock().getTime();
  function remember(client) {
    let entry = clients.get(client);
    if (!entry) {
      if (clients.size >= maxTrackedClients) {
        for (const [key, candidate] of clients) {
          if (candidate.lockedUntil <= now() && candidate.failures.every((at) => now() - at >= lockoutMs)) clients.delete(key);
        }
        // Every remembered client is still counting: forget the oldest.
        if (clients.size >= maxTrackedClients) clients.delete(clients.keys().next().value);
      }
      entry = { failures: [], lockedUntil: 0 };
      clients.set(client, entry);
    }
    return entry;
  }
  function authorized(supplied, client) {
    const wait = { ok: false, status: 429, message: 'Too many wrong PINs. Try again later.' };
    if (now() < globalLockedUntil || now() < (clients.get(client)?.lockedUntil ?? 0)) return wait;
    if (pinMatches(operatorPin, supplied)) { clients.delete(client); return { ok: true }; }
    const entry = remember(client);
    entry.failures = [...entry.failures.filter((at) => now() - at < lockoutMs), now()];
    if (entry.failures.length >= maxFailures) { entry.lockedUntil = now() + lockoutMs; entry.failures = []; }
    globalFailures = [...globalFailures.filter((at) => now() - at < lockoutMs), now()];
    if (globalFailures.length >= globalMaxFailures) { globalLockedUntil = now() + lockoutMs; globalFailures = []; }
    return { ok: false, status: 401, message: 'Wrong PIN.' };
  }

  async function trigger() {
    if (current) return { status: 409, message: `A run started here at ${current.startedAt} is still active.` };
    const challenged = await unreviewedChallenges();
    if (challenged.length) {
      return { status: 409, message: `The crawl is halted: ${challenged.length} challenge stop${challenged.length === 1 ? '' : 's'} (first ${challenged[0].url}) await review. Review them with npm run review before starting a run.` };
    }
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
    const challenged = await unreviewedChallenges();
    const halted = challenged.length ? ` The crawl is halted: ${challenged.length} challenge stop(s) await review.` : '';
    return { status: 200, message: `${current ? `A run started at ${current.startedAt} is active.` : 'No run is active here.'}${halted}`,
      detail: { active: Boolean(current), last, challengesAwaitingReview: challenged, summary } };
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
      const check = authorized(request.headers['x-operator-pin'] ?? body.pin, clientOf(request, trustedProxyHops));
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
