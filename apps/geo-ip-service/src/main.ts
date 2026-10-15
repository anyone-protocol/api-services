import { commonEnv, createLogger, handleShutdownSignals, parseEnv } from '@anyone-protocol/service-kit';
import { startServer } from './app';

const config = parseEnv(commonEnv);
const logger = createLogger({ service: 'geo-ip-service', level: config.LOG_LEVEL });
const server = startServer(config.PORT);

logger.info('Listening', { port: server.port });

handleShutdownSignals([['http server', () => server.stop()]], { logger });
