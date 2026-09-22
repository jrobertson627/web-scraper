import { createServer } from 'node:http';
import { publicationStatus } from '../config/authorization.mjs';
import { contractFingerprint, dataContractStatus } from '../config/data-contract.mjs';

export function createQueryService(persistence) {
  return Object.freeze({
    listSchools: () => persistence.queryModels().schools,
    listSeasons: () => persistence.queryModels().seasons,
    listGames: () => persistence.queryModels().games,
    health: () => persistence.queryModels().health,
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createApiServer({ queries, config, clock = () => new Date() }) {
  return createServer((request, response) => {
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
    const routes = { '/health': queries.health, '/schools': queries.listSchools, '/seasons': queries.listSeasons, '/games': queries.listGames };
    const query = routes[pathname];
    if (!query) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    sendJson(response, 200, query());
  });
}
