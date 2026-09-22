import { pathToFileURL } from 'node:url';
import { createFixtureApplication } from './composition-root.mjs';
import { validateConfiguration } from '../config/configuration.mjs';

export const EXIT_CODES = Object.freeze({
  success: 0,
  runtimeFailure: 1,
  invalidMode: 2,
  configurationRejected: 3,
  sourceAdapterMissing: 4,
});

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(password|secret|token|credential)=\S+/gi, '$1=[redacted]');
}

function parseAuthorization(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('authorization configuration is invalid JSON. Expected an authorization object; secret-bearing input was redacted.');
  }
}

function configuredPort(env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${env.PORT}. Expected an integer from 1 through 65535.`);
  }
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function runCli({
  mode = process.argv[2] ?? 'local',
  env = process.env,
  stdout = (message) => console.log(message),
  stderr = (message) => console.error(message),
} = {}) {
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
    stdout(JSON.stringify({ mode, lifecycle: app.lifecycle.state, ...result }, null, 2));
    return { exitCode: EXIT_CODES.success, app };
  }

  if (mode === 'api') {
    const app = createFixtureApplication();
    app.lifecycle.ready();
    try {
      await app.runWorkerOnce();
      const port = configuredPort(env);
      const server = app.createApiServer();
      let closing;
      const close = () => {
        if (closing) return closing;
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        closing = new Promise((resolve, reject) => server.close((error) => {
          app.lifecycle.stop();
          if (error) reject(error);
          else resolve();
        }));
        return closing;
      };
      const onSignal = () => { void close(); };
      await listen(server, port);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      app.lifecycle.running();
      stdout(`API ready on http://127.0.0.1:${port}`);
      return { exitCode: EXIT_CODES.success, app, server, close };
    } catch (error) {
      app.lifecycle.stop();
      throw error;
    }
  }

  if (mode === 'worker') {
    let config;
    try {
      config = validateConfiguration({
        mode: 'worker', providerId: env.PROVIDER_ID ?? 'provider', allowedHosts: [env.PROVIDER_HOST ?? 'provider.example'],
        rawStore: 'filesystem', publication: 'private',
        policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: env.USER_AGENT ?? '' },
        eligibilityPredicate: env.ELIGIBILITY_PREDICATE ?? 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
        authorization: parseAuthorization(env.AUTHORIZATION_JSON),
      });
    } catch (error) {
      stderr(`worker configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    stderr(`worker configuration accepted for ${config.providerId}, but no production source adapter is configured; no crawl started`);
    return { exitCode: EXIT_CODES.sourceAdapterMissing };
  }

  stderr(`invalid runtime mode: ${mode}. Expected local, worker, or api. Example: npm run start:local`);
  return { exitCode: EXIT_CODES.invalidMode };
}

async function main() {
  try {
    const result = await runCli();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`runtime startup failed: ${safeMessage(error)}`);
    process.exitCode = EXIT_CODES.runtimeFailure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
