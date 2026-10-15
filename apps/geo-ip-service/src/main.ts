import { GEO_IP_CLIENT_DEFAULTS } from '@anyone-protocol/geo-ip-client';
import { commonEnv, createLogger, env, handleShutdownSignals, handleUncaughtErrors, parseEnv } from '@anyone-protocol/service-kit';
import { startServer } from './app';
import { maxMindEnv, updateScheduleEnv } from './config';
import { type DatabaseState, GeoDatabases } from './databases';
import { MaxMindDownloads } from './maxmind-downloads';
import { DatabaseUpdater } from './updater';

const config = parseEnv({
  ...commonEnv,
  ...maxMindEnv,
  ...updateScheduleEnv,
  MAX_BATCH_SIZE: env.integer({ default: GEO_IP_CLIENT_DEFAULTS.maxBatchSize }),
});
const logger = createLogger({ service: 'geo-ip-service', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const databases = new GeoDatabases();
const updater = new DatabaseUpdater({
  directory: config.GEOIP_DATA_DIR,
  databases,
  downloads: config.MAXMIND_LICENSE_KEY && new MaxMindDownloads({ baseUrl: config.MAXMIND_DOWNLOAD_URL, licenseKey: config.MAXMIND_LICENSE_KEY }),
  maxAgeMs: config.GEOIP_MAX_AGE,
  minRequestIntervalMs: config.MAXMIND_MIN_REQUEST_INTERVAL,
  logger,
});

function logLoaded(states: DatabaseState[]) {
  for (const state of states) {
    if (state.loaded) {
      logger.info('Database loaded', { ...state });
    } else {
      logger.warn('Database not loaded', { ...state });
    }
  }
}

logLoaded(await databases.loadAll(config.GEOIP_DATA_DIR));

const server = startServer({ port: config.PORT, databases, maxBatchSize: config.MAX_BATCH_SIZE, updater });
logger.info('Listening', { port: server.port, maxBatchSize: config.MAX_BATCH_SIZE });

if (updater.enabled) {
  logger.info('Database updates enabled', {
    checkIntervalMs: config.GEOIP_CHECK_INTERVAL,
    maxAgeMs: config.GEOIP_MAX_AGE,
    minRequestIntervalMs: config.MAXMIND_MIN_REQUEST_INTERVAL,
  });
} else {
  logger.info('Database updates disabled without a MaxMind license key');
}
updater.start(config.GEOIP_CHECK_INTERVAL);

process.on('SIGHUP', async () => {
  logger.info('Reloading databases from disk', { signal: 'SIGHUP' });
  logLoaded(await databases.loadAll(config.GEOIP_DATA_DIR));
});

handleShutdownSignals(
  [
    ['database updates', () => updater.stop()],
    ['http server', () => server.stop()],
  ],
  { logger },
);
