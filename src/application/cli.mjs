import { createFixtureApplication } from './composition-root.mjs';
import { validateConfiguration } from '../config/configuration.mjs';

const mode = process.argv[2] ?? 'local';

if (mode === 'local') {
  const app = createFixtureApplication();
  app.lifecycle.ready();
  app.lifecycle.running();
  let result;
  try {
    result = await app.runWorkerOnce();
  } finally {
    app.lifecycle.stop();
  }
  console.log(JSON.stringify({ mode, lifecycle: app.lifecycle.state, ...result }, null, 2));
} else if (mode === 'api') {
  const app = createFixtureApplication();
  app.lifecycle.ready();
  const configuredPort = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new Error(`invalid PORT: ${process.env.PORT}. Expected an integer from 1 through 65535.`);
  }
  const server = app.createApiServer();
  const close = () => server.close(() => app.lifecycle.stop());
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.listen(configuredPort, '127.0.0.1', () => {
    app.lifecycle.running();
    console.log(`API ready on http://127.0.0.1:${configuredPort}`);
  });
} else if (mode === 'worker') {
  const config = validateConfiguration({
    mode: 'worker', providerId: process.env.PROVIDER_ID ?? 'provider', allowedHosts: [process.env.PROVIDER_HOST ?? 'provider.example'],
    rawStore: 'filesystem', publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: process.env.USER_AGENT ?? '' },
    eligibilityPredicate: process.env.ELIGIBILITY_PREDICATE ?? 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    authorization: process.env.AUTHORIZATION_JSON ? JSON.parse(process.env.AUTHORIZATION_JSON) : undefined,
  });
  console.error(`worker configuration accepted for ${config.providerId}, but no production source adapter is configured; no crawl started`);
  process.exitCode = 1;
} else {
  console.error(`invalid runtime mode: ${mode}. Expected local, worker, or api. Example: npm run start:local`);
  process.exitCode = 2;
}
