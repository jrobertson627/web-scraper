// Captures real Sports Reference pages as immutable raw-HTML fixtures (#38).
// Usage: USER_AGENT="web-scraper (+contact)" node scripts/capture-fixtures.mjs <path> [<path> ...]
// Paths are site paths such as /cbb/schools/duke/men/2024.html. Already-captured
// paths are skipped; any non-200 response, redirect, or challenge stops the run.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpTransport } from '../src/fetcher/http-transport.mjs';

const ORIGIN = 'https://www.sports-reference.com';
const MIN_INTERVAL_MS = 7000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sports-reference');
const manifestPath = join(root, 'manifest.json');

const userAgent = process.env.USER_AGENT;
if (!userAgent || !/\(\+[^)\s]+\)/.test(userAgent)) {
  console.error('USER_AGENT must name the application and a contact, e.g. "web-scraper (+ops@example.com)"');
  process.exit(2);
}
const paths = process.argv.slice(2);
if (paths.length === 0 || paths.some((path) => !path.startsWith('/'))) {
  console.error('pass one or more site paths starting with "/"');
  process.exit(2);
}

function fixtureFile(path) {
  const trimmed = path.replace(/^\/+/, '').replace(/\/$/, '/index.html');
  return join('raw', trimmed.endsWith('.html') ? trimmed : `${trimmed}.html`);
}

let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const transport = new HttpTransport();
let lastStart = 0;
for (const path of paths) {
  if (manifest[path]) {
    console.log(`skip ${path} (captured ${manifest[path].fetchedAt})`);
    continue;
  }
  const wait = lastStart + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastStart = Date.now();
  const url = `${ORIGIN}${path}`;
  const response = await transport.request({
    method: 'GET', url, redirect: 'manual', timeoutMs: 30000, maxResponseBytes: 20 * 1024 * 1024,
    headers: { 'user-agent': userAgent, accept: 'text/html' },
  });
  if (response.status !== 200 || response.challenge) {
    const detail = response.redirectUrl ? ` -> ${response.redirectUrl}` : '';
    const retryAfter = response.headers['retry-after'] ? ` retry-after=${response.headers['retry-after']}` : '';
    console.error(`STOP ${path}: status ${response.status}${response.challenge ? ' (challenge)' : ''}${detail}${retryAfter}`);
    process.exit(1);
  }
  const file = fixtureFile(path);
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), response.body);
  manifest[path] = {
    url,
    file: file.replaceAll('\\', '/'),
    fetchedAt: new Date(lastStart).toISOString(),
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    etag: response.headers.etag ?? null,
    lastModified: response.headers['last-modified'] ?? null,
    bytes: response.body.length,
    sha256: createHash('sha256').update(response.body).digest('hex'),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`saved ${path} -> ${manifest[path].file} (${response.body.length} bytes)`);
}
