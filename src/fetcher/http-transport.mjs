import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blockedV4.addSubnet(network, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['::ffff:0:0', 96], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20],
]) blockedV6.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) {
    return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  }
  return false;
}

export class TransportFailure extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TransportFailure';
    this.code = code;
  }
}

function classifyError(error) {
  if (error instanceof TransportFailure) return error;
  const code = String(error?.code ?? '');
  if (/^(?:ERR_INVALID_CHAR|ERR_HTTP_INVALID_HEADER_VALUE)$/.test(code)) {
    return new TransportFailure('invalid_request', 'request contains an invalid header value', { cause: error });
  }
  if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code)) {
    return new TransportFailure('tls_rejected', 'TLS certificate verification failed', { cause: error });
  }
  return new TransportFailure('transient_network', `network request failed: ${code || error?.message || 'unknown error'}`, { cause: error });
}

function normalizedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));
}

function isChallenge(status, headers, body) {
  if (status === 403) return true;
  const marker = `${headers['cf-mitigated'] ?? ''} ${headers['x-captcha'] ?? ''}`;
  if (/challenge|captcha/i.test(marker)) return true;
  if (!/html/i.test(headers['content-type'] ?? '')) return false;
  const html = body.toString('utf8');
  return /<title>\s*(?:just a moment|access denied|captcha challenge)\b/i.test(html)
    || /<(?:iframe|div|input)[^>]+(?:g-recaptcha|h-captcha|cf-chl|captcha)/i.test(html);
}

// How long one address gets to accept a connection when another is left to try.
const CONNECT_TIMEOUT_MS = 5_000;

export class HttpTransport {
  // connectTimeoutMs bounds a connection attempt to an address that has others
  // behind it, so an unroutable first address cannot use the whole deadline.
  constructor({ resolve = (host) => lookup(host, { all: true }), allowAddress = isPublicAddress, ca, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    this.resolve = resolve;
    this.allowAddress = allowAddress;
    this.ca = ca;
    this.connectTimeoutMs = connectTimeoutMs;
    // The address family that last connected; tried first next time, so a host
    // with no route for one family pays for it once, not on every request.
    this.preferredFamily = null;
  }

  async request({ method, url, headers = {}, redirect = 'manual', timeoutMs, maxResponseBytes }) {
    if (method !== 'GET' || redirect !== 'manual') throw new TransportFailure('invalid_request', 'real transport requires GET and manual redirects');
    let target;
    try { target = new URL(url); } catch { throw new TransportFailure('invalid_request', 'request URL is invalid'); }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
      throw new TransportFailure('invalid_request', 'real transport requires a credential-free HTTPS URL');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new TransportFailure('invalid_request', 'request timeout and response limit must be positive integers');
    }

    const deadline = Date.now() + timeoutMs;
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
      addresses = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TransportFailure('transport_timeout', 'request timed out during DNS lookup')), timeoutMs);
        Promise.resolve().then(() => isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : this.resolve(hostname)).then(
          (result) => { clearTimeout(timer); resolve(result); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
    } catch (error) { throw classifyError(error); }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) =>
      !entry || typeof entry.address !== 'string' || isIP(entry.address) !== entry.family || !this.allowAddress(entry.address))) {
      throw new TransportFailure('dns_rejected', 'resolved address is missing or outside the public address policy');
    }
    // Every address was checked above. Try them in turn, the family that last
    // worked first, moving on only when a connection could not be made (nothing
    // was sent, so pacing is unaffected) and never past the request deadline.
    const ordered = [...addresses].sort((left, right) => Number(right.family === this.preferredFamily) - Number(left.family === this.preferredFamily));
    let failure;
    for (const [index, selected] of ordered.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure ?? new TransportFailure('transport_timeout', 'request timed out before connection');
      const last = index === ordered.length - 1;
      try {
        const response = await this.#attempt({
          target, selected, headers, remaining, maxResponseBytes,
          // The last address has the whole deadline; others a bounded share of it.
          connectTimeoutMs: last ? null : Math.min(this.connectTimeoutMs, remaining / 2),
        });
        this.preferredFamily = selected.family;
        return response;
      } catch (error) {
        failure = error;
        if (!error?.connectFailure || last) throw error;
      }
    }
    throw failure;
  }

  // One request to one validated address. A rejection with connectFailure set
  // means no connection was made, so another address may be tried.
  #attempt({ target, selected, headers, remaining, maxResponseBytes, connectTimeoutMs }) {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let failure;
      let timer;
      let connectTimer;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        if (!error) { resolve(response); return; }
        const classified = classifyError(error);
        if (!connected && ['transient_network', 'connect_timeout'].includes(classified.code)) classified.connectFailure = true;
        reject(classified);
      };
      const request = httpsRequest(target, {
        method: 'GET', headers: { ...headers, 'accept-encoding': 'identity' }, agent: false,
        ca: this.ca, servername: isIP(hostname) ? undefined : hostname,
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      }, (response) => {
        const responseHeaders = normalizedHeaders(response.headers);
        const encoding = responseHeaders['content-encoding'];
        if (encoding && encoding.toLowerCase() !== 'identity') {
          failure = new TransportFailure('unsupported_encoding', `unsupported response encoding: ${encoding}`);
          request.destroy(failure);
          return;
        }
        const declaredLength = Number(responseHeaders['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          failure = new TransportFailure('response_too_large', 'response body exceeds the configured byte limit');
          request.destroy(failure);
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            failure = new TransportFailure('response_too_large', 'response body exceeds the configured byte limit');
            request.destroy(failure);
          } else chunks.push(chunk);
        });
        response.on('error', (error) => { failure = classifyError(error); request.destroy(failure); });
        response.on('end', () => {
          if (failure) return;
          const body = Buffer.concat(chunks, size);
          const status = response.statusCode;
          if (!Number.isInteger(status)) return finish(new TransportFailure('malformed_response', 'response has no status code'));
          finish(null, {
            status, headers: responseHeaders, body,
            redirectUrl: [301, 302, 303, 307, 308].includes(status) ? responseHeaders.location : undefined,
            challenge: isChallenge(status, responseHeaders, body),
          });
        });
      });
      request.on('socket', (socket) => {
        const onConnect = () => { connected = true; clearTimeout(connectTimer); };
        if (socket.connecting) socket.once('connect', onConnect); else onConnect();
      });
      request.on('error', (error) => { failure = classifyError(error); });
      request.on('close', () => { if (!settled) finish(failure ?? new TransportFailure('transient_network', 'connection closed before response completed')); });
      if (connectTimeoutMs !== null) {
        connectTimer = setTimeout(() => {
          if (connected) return;
          failure = new TransportFailure('connect_timeout', 'connection attempt timed out');
          request.destroy(failure);
        }, connectTimeoutMs);
      }
      timer = setTimeout(() => {
        failure = new TransportFailure('transport_timeout', 'request timed out');
        request.destroy(failure);
      }, remaining);
      request.end();
    });
  }
}
