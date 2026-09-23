import { createServer } from 'node:http';
import { publicationStatus } from '../config/authorization.mjs';
import { contractFingerprint, dataContractStatus } from '../config/data-contract.mjs';

export function createQueryService(persistence) {
  return Object.freeze({
    listSchools: async () => (await persistence.queryModels()).schools,
    listSeasons: async () => (await persistence.queryModels()).seasons,
    listGames: async () => (await persistence.queryModels()).games,
    getGame: async (key) => (await persistence.queryModels()).games.find((game) => game.gameKey === key) ?? null,
    health: async () => (await persistence.queryModels()).health,
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
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
    const pathname = new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
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
    const routes = { '/health': queries.health, '/schools': queries.listSchools, '/seasons': queries.listSeasons, '/games': queries.listGames };
    const query = routes[pathname];
    if (!query) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    sendJson(response, 200, await query());
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'read query failed' });
      else response.destroy();
    }
  });
}
