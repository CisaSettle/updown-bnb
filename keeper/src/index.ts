#!/usr/bin/env node
/**
 * UpDown keeper entrypoint.
 *
 * Boots the supervisor, serves `/healthz` and `/metrics`, and shuts down cleanly on SIGINT/SIGTERM
 * without abandoning an in-flight transaction.
 */

import { loadConfig, redactedConfig, ConfigError } from './config.js';
import { createLogger, registerSecret, scrubSecrets } from './logger.js';
import { Keeper, VERSION } from './keeper.js';
import { startServer, type RunningServer } from './server.js';

async function main(): Promise<void> {
  let config;
  // Register the credentials BEFORE anything can log. viem stamps the full RPC URL into
  // `error.message` on every transport failure and only strips basic-auth from it, so an API key
  // in the path or query would otherwise be printed verbatim on the first RPC hiccup.
  registerSecret(process.env['RPC_URL']);
  registerSecret(process.env['KEEPER_PRIVATE_KEY']);
  registerSecret(process.env['PRICE_API']);

  // A bootstrap logger, so configuration errors are still structured output.
  const bootLogger = createLogger({ level: 'info', base: { service: 'updown-keeper', version: VERSION } });
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      bootLogger.error('configuration error; refusing to start', { detail: error.message });
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'updown-keeper', version: VERSION, chainId: config.chainId },
  });
  logger.info('starting', redactedConfig(config));

  const keeper = new Keeper({ config, logger });

  // One bad market, one bad RPC response or one unexpected rejection must never kill the keeper.
  process.on('unhandledRejection', (reason) => {
    keeper.noteUncaught();
    logger.error('unhandled rejection (keeper continues)', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    keeper.noteUncaught();
    logger.error('uncaught exception (keeper continues)', { error });
  });

  let server: RunningServer | null = null;
  try {
    await keeper.start();
    server = await startServer({
      port: config.metricsPort,
      host: config.metricsHost,
      metrics: keeper.metrics,
      health: () => keeper.health(),
      logger,
      version: VERSION,
    });
  } catch (error) {
    logger.error('startup failed', { error });
    await keeper.stop();
    await server?.close();
    process.exitCode = 1;
    return;
  }

  // An RPC that answered the chain-id check and then failed every market read leaves every market
  // unbootstrapped. The keeper stays up by default, reporting unhealthy and retrying, because the
  // markets come back on their own the moment the reads succeed. Handing the problem to a supervisor
  // instead is a deliberate configuration, not the side effect of an exception thrown before the
  // retry timer existed. (An RPC that is unreachable outright fails `keeper.start()` above, at the
  // chain-id check, and is handled by the catch there.)
  if (keeper.totalBootstrapFailure !== null && config.exitOnTotalBootstrapFailure) {
    logger.error('no market could be bootstrapped; exiting for the supervisor to restart', {
      detail: keeper.totalBootstrapFailure,
      exitOnTotalBootstrapFailure: true,
    });
    await keeper.stop();
    await server?.close();
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    void (async () => {
      await keeper.stop();
      await server?.close();
      logger.info('stopped');
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the event loop alive: every keeper timer is unref'd so it cannot hold the process open
  // on its own, which is what makes shutdown deterministic.
  const heartbeat = setInterval(() => {}, 1 << 30);
  process.on('exit', () => clearInterval(heartbeat));
}

main().catch((error: unknown) => {
  // Last resort: structured, then non-zero. Scrubbed like every other line.
  process.stdout.write(
    scrubSecrets(JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      msg: 'fatal',
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    })) + '\n',
  );
  process.exit(1);
});
