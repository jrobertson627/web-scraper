import { createServer } from 'node:http';
import { publicationStatus } from '../config/authorization.mjs';
import { contractFingerprint, dataContractStatus } from '../config/data-contract.mjs';
import { assertBoundaryPort, createPageRequest } from '../contracts/boundaries.mjs';
import { API_FIELDS, MAPPED_RETAINED_FIELDS, retainFields } from '../contracts/retained-fields.mjs';

// Each route maps to one keyed or paged persistence read; no route loads the
// whole read model. List methods take { limit, cursor } and return
// { items, nextCursor }. Every item is served with only the fields the data
// contract retains (#89), so rows stored before a contract narrowed are
// filtered too. Without a contract every mapped field is served.
export function createQueryService(persistence, { retainedFields = MAPPED_RETAINED_FIELDS } = {}) {
  const reads = assertBoundaryPort('persistenceReads', persistence);
  const retained = Object.freeze([...retainedFields]);
  const serve = (spec, item) => (item ? retainFields(spec, item, retained).value : item);
  const servePage = (spec, page) => ({ ...page, items: page.items.map((item) => serve(spec, item)) });
  return Object.freeze({
    listSchools: async (paging) => servePage(API_FIELDS.school, await reads.listSchools(createPageRequest(paging))),
    listSeasons: async (paging) => servePage(API_FIELDS.season, await reads.listSeasons(createPageRequest(paging))),
    listGames: async (paging) => servePage(API_FIELDS.game, await reads.listGames(createPageRequest(paging))),
    getGame: async (key) => serve(API_FIELDS.game, await reads.getGame(key)),
    health: async () => reads.health(),
  });
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

// List bodies stay plain arrays; the next page is advertised the way RFC 8288
// does it, in a Link header, and as X-Next-Cursor for simple clients.
function nextPageHeaders(pathname, limit, nextCursor) {
  if (!nextCursor) return {};
  const next = `${pathname}?${new URLSearchParams({ limit: String(limit), cursor: nextCursor })}`;
  return { link: `<${next}>; rel="next"`, 'x-next-cursor': nextCursor };
}

export function createApiServer({ queries, config, clock = () => new Date() }) {
  return createServer(async (request, response) => {
    try {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'read-only API accepts GET only' });
      return;
    }
    if (config.publication === 'public') {
      const gate = publicationStatus(config.authorization, config.dataContract, config.providerId, clock, {
        expectedContractVersion: config.dataContract?.version,
        expectedContractFingerprint: config.dataContract ? contractFingerprint(config.dataContract) : undefined,
        expectedScope: config.allowedHosts ? { allowedHosts: config.allowedHosts, eligibilityPredicate: config.eligibilityPredicate, targetEndingYears: config.targetEndingYears } : undefined,
        dataContractStatus,
      });
      if (!gate.ok) {
        sendJson(response, 403, { error: 'publication gate denied' });
        return;
      }
    }
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    if (pathname.startsWith('/games/')) {
      let key;
      try { key = decodeURIComponent(pathname.slice('/games/'.length)); } catch {
        sendJson(response, 400, { error: 'invalid game key' });
        return;
      }
      const game = await queries.getGame(key);
      sendJson(response, game ? 200 : 404, game ?? { error: 'not found' });
      return;
    }
    if (pathname === '/health') {
      sendJson(response, 200, await queries.health());
      return;
    }
    const lists = { '/schools': queries.listSchools, '/seasons': queries.listSeasons, '/games': queries.listGames };
    const list = lists[pathname];
    if (!list) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    let paging;
    try {
      paging = createPageRequest({ limit: url.searchParams.get('limit') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    let page;
    try {
      page = await list(paging);
    } catch (error) {
      if (error?.code !== 'invalid_paging') throw error;
      sendJson(response, 400, { error: error.message });
      return;
    }
    sendJson(response, 200, page.items, nextPageHeaders(pathname, paging.limit, page.nextCursor));
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'read query failed' });
      else response.destroy();
    }
  });
}
