import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Fetcher } from '../src/fetcher/index.mjs';
import { HttpTransport, isPublicAddress } from '../src/fetcher/http-transport.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';

const key = readFileSync(new URL('./fixtures/local-tls-key.pem', import.meta.url));
const ca = readFileSync(new URL('./fixtures/local-tls-cert.pem', import.meta.url));
const basePolicy = {
  minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1,
  userAgent: 'milestone-test (+ops@example.com)', requestTimeoutMs: 1_000,
};

async function serverFor(handler) {
  const requests = [];
  const server = createServer({ key, cert: ca }, (request, response) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host, headers: { ...request.headers } });
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    requests, port,
    url: (path, host = 'scraper.test') => `https://${host}:${port}${path}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function setup(origin, { policy = {}, transport, path = '/page', host = 'scraper.test' } = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const sleep = async (ms) => { now += ms; };
  const sourceUrl = createSourceUrl('provider', origin.url(path, host));
  const persistence = new InMemoryPersistence(clock);
  const rawStore = new MemoryRawStore();
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const fetcher = new Fetcher({
    transport: transport ?? new HttpTransport({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      allowAddress: (address) => address === '127.0.0.1', ca,
    }),
    rawStore, persistence, clock, sleep,
    allowedHosts: [`scraper.test:${origin.port}`, `other.test:${origin.port}`],
    policy: { ...basePolicy, ...policy },
  });
  return {
    fetcher, persistence, rawStore, clock, advance: (ms) => { now += ms; },
    claim: () => persistence.claimNextJob(clock(), 'worker'),
    orchestrator: () => new IngestionOrchestrator({ fetcher, persistence, rawStore, clock }),
  };
}

test('real transport enforces HTTPS, public DNS, manual redirects, and per-hop ownership', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const origin = await serverFor((request, response) => {
    if (request.url === '/start') { response.writeHead(302, { location: `https://other.test:${origin.port}/final` }); response.end(); }
    else if (request.url === '/off-host') { response.writeHead(302, { location: 'https://blocked.test/secret' }); response.end(); }
    else if (request.url === '/cycle') { response.writeHead(302, { location: '/cycle' }); response.end(); }
    else { response.writeHead(200); response.end('hello'); }
  });
  try {
    const run = setup(origin, { path: '/start' });
    const job = run.claim();
    const result = await run.fetcher.fetch(job, job.lease);
    assert.equal(result.kind, 'fetched');
    assert.equal(run.rawStore.get(result.checksum).body.toString(), 'hello');
    assert.deepEqual(origin.requests.map((item) => item.host), [`scraper.test:${origin.port}`, `other.test:${origin.port}`]);
    assert.equal(origin.requests.every((item) => item.method === 'GET'), true);
    assert.deepEqual(run.persistence.requestHistory.map((item) => item.host), [`scraper.test:${origin.port}`, `other.test:${origin.port}`]);

    const offHost = setup(origin, { path: '/off-host' });
    const offHostJob = offHost.claim();
    assert.equal((await offHost.fetcher.fetch(offHostJob, offHostJob.lease)).kind, 'operator_stop');
    assert.equal(origin.requests.length, 3);
    const cycle = setup(origin, { path: '/cycle', policy: { maxRedirects: 1 } });
    const cycleJob = cycle.claim();
    assert.equal((await cycle.fetcher.fetch(cycleJob, cycleJob.lease)).kind, 'operator_stop');
    assert.equal(origin.requests.length, 5);

    const denied = setup(origin, { transport: new HttpTransport({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], ca }) });
    const deniedJob = denied.claim();
    const deniedResult = await denied.fetcher.fetch(deniedJob, deniedJob.lease);
    assert.equal(deniedResult.kind, 'operator_stop');
    assert.equal(deniedResult.code, 'dns_rejected');
    assert.equal(origin.requests.length, 5);
    const mixed = setup(origin, { transport: new HttpTransport({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], ca,
    }) });
    const mixedJob = mixed.claim();
    assert.equal((await mixed.fetcher.fetch(mixedJob, mixedJob.lease)).code, 'dns_rejected');
    assert.equal(origin.requests.length, 5);
    await assert.rejects(
      new HttpTransport().request({ method: 'GET', url: 'http://scraper.test/', timeoutMs: 1_000, maxResponseBytes: 1024 }),
      { code: 'invalid_request' },
    );
  } finally { await origin.close(); }
});

test('timeout cancels the socket and oversized or untrusted responses stop safely', async () => {
  const origin = await serverFor((request, response) => {
    if (request.url === '/hang') return;
    if (request.url === '/stall') { response.write('partial'); return; }
    if (request.url === '/large') { response.write('a'.repeat(700)); response.end('b'.repeat(700)); return; }
    if (request.url === '/encoded') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end('not really gzip'); return; }
    response.end('ok');
  });
  try {
    const timeout = setup(origin, { path: '/hang', policy: { requestTimeoutMs: 1_000 } });
    const job = timeout.claim();
    const started = Date.now();
    const result = await timeout.fetcher.fetch(job, job.lease);
    assert.equal(result.kind, 'retry_wait');
    assert.equal(result.code, 'transport_timeout');
    assert.ok(Date.now() - started < 3_000);
    assert.equal(timeout.persistence.inFlight.size, 0);
    const stalled = setup(origin, { path: '/stall' });
    const stalledJob = stalled.claim();
    assert.equal((await stalled.fetcher.fetch(stalledJob, stalledJob.lease)).code, 'transport_timeout');
    assert.equal(stalled.persistence.inFlight.size, 0);

    const large = setup(origin, { path: '/large', policy: { maxResponseBytes: 1024 } });
    const largeJob = large.claim();
    const largeResult = await large.fetcher.fetch(largeJob, largeJob.lease);
    assert.equal(largeResult.kind, 'operator_stop');
    assert.equal(largeResult.code, 'response_too_large');
    assert.equal(large.rawStore.entries().length, 0);
    const encoded = setup(origin, { path: '/encoded' });
    const encodedJob = encoded.claim();
    assert.equal((await encoded.fetcher.fetch(encodedJob, encodedJob.lease)).code, 'unsupported_encoding');

    const untrusted = setup(origin, { transport: new HttpTransport({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      allowAddress: () => true,
    }) });
    const untrustedJob = untrusted.claim();
    assert.equal((await untrusted.fetcher.fetch(untrustedJob, untrustedJob.lease)).code, 'tls_rejected');
  } finally { await origin.close(); }
});

test('a slow real response renews the claim until its socket settles', async () => {
  const origin = await serverFor((_request, response) => {
    setTimeout(() => { response.writeHead(200); response.end('slow but valid'); }, 450);
  });
  try {
    const run = setup(origin);
    run.persistence.claimTimeoutMs = 180;
    run.persistence.clock = () => new Date();
    run.fetcher.clock = () => new Date();
    const job = run.persistence.claimNextJob(new Date(), 'worker');
    const result = await run.fetcher.fetch(job, job.lease);
    assert.equal(result.kind, 'fetched');
    assert.ok(new Date(run.persistence.getJob('job').claim.expiresAt).getTime() > Date.now());
  } finally { await origin.close(); }
});

test('real responses drive fresh cache, conditional 304, and changed-body records', async () => {
  let body = 'first';
  let etag = '"first"';
  const modified = 'Wed, 01 Jan 2025 00:00:00 GMT';
  const origin = await serverFor((request, response) => {
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag, 'last-modified': modified }); response.end(); return; }
    response.writeHead(200, { etag, 'last-modified': modified, 'cache-control': 'public' });
    response.end(body);
  });
  try {
    const run = setup(origin, { policy: { cacheMaxAgeMs: 10_000 } });
    const job = run.claim();
    const first = await run.fetcher.fetch(job, job.lease);
    assert.equal(first.kind, 'fetched');
    assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'not_modified');
    assert.equal(origin.requests.length, 1);
    assert.equal(run.persistence.sourceFetches[1].cacheHit, true);
    run.advance(11_000);
    const unchanged = await run.fetcher.fetch(job, job.lease);
    assert.equal(unchanged.kind, 'not_modified');
    assert.equal(origin.requests[1].headers['if-none-match'], '"first"');
    assert.equal(origin.requests[1].headers['if-modified-since'], modified);
    assert.equal(run.rawStore.entries().length, 1);
    body = 'second'; etag = '"second"'; run.advance(11_000);
    const changed = await run.fetcher.fetch(job, job.lease);
    assert.equal(changed.kind, 'fetched');
    assert.notEqual(changed.checksum, first.checksum);
    assert.deepEqual(run.persistence.sourceFetches.map((item) => item.status), [200, 200, 304, 200]);
    assert.equal(run.rawStore.entries().length, 2);
  } finally { await origin.close(); }
});

test('upstream cache restrictions prevent fresh reuse and no-store suppresses validators', async () => {
  let directive = 'no-cache';
  const origin = await serverFor((request, response) => {
    if (request.headers['if-none-match'] === '"stable"') { response.writeHead(304, { etag: '"stable"', 'cache-control': directive }); response.end(); return; }
    response.writeHead(200, { etag: '"stable"', 'cache-control': directive }); response.end('same body');
  });
  try {
    for (const [value, conditional] of [['no-cache', true], ['no-store', false], ['max-age=0', true]]) {
      directive = value;
      const before = origin.requests.length;
      const run = setup(origin, { policy: { cacheMaxAgeMs: 10_000 } });
      const job = run.claim();
      assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'fetched');
      assert.equal((await run.fetcher.fetch(job, job.lease)).kind, conditional ? 'not_modified' : 'fetched');
      assert.equal(origin.requests.length - before, 2);
      assert.equal(Boolean(origin.requests.at(-1).headers['if-none-match']), conditional);
      assert.equal(run.persistence.sourceFetches[1].cacheHit, false);
    }
  } finally { await origin.close(); }
});

test('a real 304 cannot reuse an unverifiable immutable body', async () => {
  const origin = await serverFor((request, response) => {
    if (request.headers['if-none-match']) { response.writeHead(304); response.end(); return; }
    response.writeHead(200, { etag: '"verified"' }); response.end('original');
  });
  try {
    const run = setup(origin, { policy: { cacheMaxAgeMs: 1_000 } });
    const job = run.claim();
    assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'fetched');
    run.advance(2_000);
    run.rawStore.verify = () => ({ ok: false, reason: 'simulated checksum mismatch' });
    const result = await run.fetcher.fetch(job, job.lease);
    assert.equal(result.kind, 'operator_stop');
    assert.equal(run.persistence.sourceFetches.length, 1);
    assert.equal(origin.requests.length, 2);
  } finally { await origin.close(); }
});

test('real 429, challenge, server errors, and socket resets produce the required job states', async () => {
  let responseKind = 'rate';
  const origin = await serverFor((request, response) => {
    if (responseKind === 'rate') { response.writeHead(429, { 'retry-after': '0' }); response.end(); }
    else if (responseKind === 'invalid-rate') { response.writeHead(429, { 'retry-after': 'bogus' }); response.end(); }
    else if (responseKind === 'long-rate') { response.writeHead(429, { 'retry-after': '86401' }); response.end(); }
    else if (responseKind === 'date-rate') { response.writeHead(429, { 'retry-after': 'Thu, 01 Jan 2026 00:00:20 GMT' }); response.end(); }
    else if (responseKind === 'rfc850-rate') { response.writeHead(429, { 'retry-after': 'Thursday, 01-Jan-26 00:00:20 GMT' }); response.end(); }
    else if (responseKind === 'asctime-rate') { response.writeHead(429, { 'retry-after': 'Thu Jan  1 00:00:20 2026' }); response.end(); }
    else if (responseKind === 'bad-date-rate') { response.writeHead(429, { 'retry-after': 'Thu, 31 Feb 2026 00:00:20 GMT' }); response.end(); }
    else if (responseKind === 'challenge') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Just a moment...</title>'); }
    else if (responseKind === 'forbidden') { response.writeHead(403); response.end(); }
    else if (responseKind === 'reset') request.socket.destroy();
    else { response.writeHead(503); response.end(); }
  });
  try {
    for (const [kind, expectedState, expectedCode] of [
      ['rate', 'retry_wait', undefined], ['invalid-rate', 'operator_stop', 'invalid_retry_after'],
      ['long-rate', 'operator_stop', 'retry_after_too_long'], ['challenge', 'operator_stop', 'challenge'],
      ['date-rate', 'retry_wait', undefined], ['rfc850-rate', 'retry_wait', undefined],
      ['asctime-rate', 'retry_wait', undefined], ['bad-date-rate', 'operator_stop', 'invalid_retry_after'],
      ['forbidden', 'operator_stop', 'challenge'], ['reset', 'retry_wait', 'transient_network'],
    ]) {
      responseKind = kind;
      const run = setup(origin);
      const result = await run.orchestrator().runOnce();
      assert.equal(result.events[0].kind, expectedState, kind);
      assert.equal(result.events[0].code, expectedCode, kind);
      assert.equal(run.persistence.getJob('job').state, expectedState, kind);
      if (kind === 'rate') assert.equal(Date.parse(result.events[0].nextAllowedAt) - run.clock().getTime(), 6_000);
      if (['date-rate', 'rfc850-rate', 'asctime-rate'].includes(kind)) {
        assert.equal(Date.parse(result.events[0].nextAllowedAt) - run.clock().getTime(), 20_000);
      }
    }

    responseKind = 'server';
    const run = setup(origin, { policy: { maxAttempts: 3, retryBaseMs: 2_000, retryMaxMs: 3_000 } });
    for (const [state, delay] of [['retry_wait', 2_000], ['retry_wait', 3_000], ['permanently_failed', null]]) {
      const result = await run.orchestrator().runOnce();
      assert.equal(result.events[0].kind, state);
      assert.equal(run.persistence.getJob('job').state, state);
      if (delay !== null) {
        assert.equal(Date.parse(result.events[0].nextAllowedAt) - run.clock().getTime(), delay);
        run.advance(delay);
      }
    }
  } finally { await origin.close(); }
});
