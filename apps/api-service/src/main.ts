import { GeoIpClient } from '@anyone-protocol/geo-ip-client';
import { createLogger, handleShutdownSignals, handleUncaughtErrors } from '@anyone-protocol/service-kit';
import { SQL } from 'bun';
import { startServer } from './app';
import { loadConfig } from './config';
import { Onionoo } from './onionoo';
import { OperatorRegistry } from './operator-registry';
import { UnsDomains, unsTokenRows } from './uns-domains';
import { RelayMetrics, VictoriaMetrics } from './victoria-metrics';

const SECOND_MS = 1000;

const config = loadConfig();
const logger = createLogger({ service: 'api-service', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const database = new SQL({
  hostname: config.DB_HOST,
  port: config.DB_PORT,
  username: config.DB_USER,
  password: config.DB_PASS?.reveal(),
  database: config.DB_NAME,
});

const server = startServer({
  port: config.PORT,
  onionoo: new Onionoo({
    baseUrl: `${config.ONIONOO_PROTOCOL}${config.ONIONOO_INSTANCE}`,
    cacheTtlMs: config.ONIONOO_DETAILS_CACHE_TTL_SECONDS * SECOND_MS,
    timeoutMs: config.ONIONOO_DETAILS_TIMEOUT_SECONDS * SECOND_MS,
  }),
  relayMetrics: new RelayMetrics(
    new VictoriaMetrics(config.VICTORIA_METRICS_ADDRESS),
    { cluster: config.CLUSTER, env: config.ENV, instance: config.ONIONOO_INSTANCE, job: config.JOB },
    { from: config.FROM, to: config.TO, interval: config.INTERVAL },
  ),
  geo: new GeoIpClient({ baseUrl: config.GEO_IP_SERVICE_URL, cacheTtlMs: config.GEO_IP_CACHE_TTL, logger }),
  hexagonResolution: config.HEXAGON_RESOLUTION,
  operatorRegistry: new OperatorRegistry({
    nodeUrl: config.HB_URL,
    processId: config.OPERATOR_REGISTRY_PROCESS_ID,
    cacheTtlMs: config.OPERATOR_REGISTRY_CACHE_TTL_SECONDS * SECOND_MS,
    logger,
  }),
  unsDomains: new UnsDomains({ rows: unsTokenRows(database), cacheTtlMs: config.UNS_DOMAINS_CACHE_TTL_SECONDS * SECOND_MS, logger }),
  logger,
});

logger.info('Listening', {
  port: server.port,
  onionoo: config.ONIONOO_INSTANCE,
  operatorRegistryProcessId: config.OPERATOR_REGISTRY_PROCESS_ID,
  geoIpService: config.GEO_IP_SERVICE_URL,
});

handleShutdownSignals(
  [
    ['http server', () => server.stop()],
    ['database', () => database.close()],
  ],
  { logger },
);
