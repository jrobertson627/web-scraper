import { createServer } from 'node:http';
import { authorizationStatus } from '../config/authorization.mjs';

export function createQueryService(persistence) {
  return Object.freeze({
    listSchools: () => persistence.queryModels().schools,
    listSeasons: () => persistence.queryModels().seasons,
    listGames: () => persistence.queryModels().games,
    health: () => persistence.queryModels().health,
  });
}

export function createApiServer({ queries, config }) {
  return createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'read-only API accepts GET only' }));
      return;
    }
    if (config.publication === 'public') {
      const gate = authorizationStatus(config.authorization, config.providerId, 'publish');
      if (!gate.ok) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'publication gate denied' }));
        return;
      }
    }
    const routes = { '/health': queries.health, '/schools': queries.listSchools, '/seasons': queries.listSeasons, '/games': queries.listGames };
    const query = routes[request.url];
    if (!query) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
      }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(query()));
  });
}
