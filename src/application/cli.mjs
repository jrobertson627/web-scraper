import { createFixtureApplication } from './composition-root.mjs';
import { validateConfiguration } from '../config/configuration.mjs';

const mode = process.argv[2] ?? 'local';

if (mode === 'local') {
  const app = createFixtureApplication();
  app.lifecycle.ready();
  app.lifecycle.running();
  const result = await app.runWorkerOnce();
  app.lifecycle.stop();
  console.log(JSON.stringify({ mode, lifecycle: app.lifecycle.state, ...result }, null, 2));
} else if (mode === 'api') {
  const app = createFixtureApplication();
  app.lifecycle.ready();
  const port = Number(process.env.PORT ?? 3000);
  const server = app.createApiServer();
  server.listen(port, () => console.log(`API ready on http://127.0.0.1:${port}`));
} else if (mode === 'worker') {
  const config = validateConfiguration({
    mode: 'worker', providerId: process.env.PROVIDER_ID ?? 'provider', allowedHosts: [process.env.PROVIDER_HOST ?? 'provider.example'],
    rawStore: 'filesystem', publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: process.env.USER_AGENT ?? '' },
    eligibilityPredicate: process.env.ELIGIBILITY_PREDICATE ?? 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    authorization: process.env.AUTHORIZATION_JSON ? JSON.parse(process.env.AUTHORIZATION_JSON) : undefined,
  });
  console.log(JSON.stringify({ mode, accepted: true, providerId: config.providerId }));
} else {
  console.error(`invalid runtime mode: ${mode}. Expected local, worker, or api. Example: npm run start:local`);
  process.exitCode = 2;
}
