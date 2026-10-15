import { commonEnv, createLogger, handleShutdownSignals, handleUncaughtErrors, parseEnv } from '@anyone-protocol/service-kit';
import { startServer } from './app';

const config = parseEnv(commonEnv);
const logger = createLogger({ service: 'geo-ip-service', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const server = startServer(config.PORT);

logger.info('Listening', { port: server.port });

handleShutdownSignals([['http server', () => server.stop()]], { logger });
