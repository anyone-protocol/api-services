import { GEO_IP_CLIENT_DEFAULTS } from '@anyone-protocol/geo-ip-client';
import { commonEnv, createLogger, env, handleShutdownSignals, handleUncaughtErrors, parseEnv } from '@anyone-protocol/service-kit';
import { startServer } from './app';
import { databasePath, EDITIONS, GeoDatabases } from './databases';

const config = parseEnv({
  ...commonEnv,
  GEOIP_DATA_DIR: env.string(),
  MAX_BATCH_SIZE: env.integer({ default: GEO_IP_CLIENT_DEFAULTS.maxBatchSize }),
});
const logger = createLogger({ service: 'geo-ip-service', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const databases = new GeoDatabases();
for (const edition of EDITIONS) {
  const state = await databases.load(edition, databasePath(config.GEOIP_DATA_DIR, edition));
  if (state.loaded) {
    logger.info('Database loaded', { ...state });
  } else {
    logger.error('Database not loaded', { ...state });
  }
}

const server = startServer({ port: config.PORT, databases, maxBatchSize: config.MAX_BATCH_SIZE });

logger.info('Listening', { port: server.port, maxBatchSize: config.MAX_BATCH_SIZE });

handleShutdownSignals([['http server', () => server.stop()]], { logger });
