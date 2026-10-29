import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, handleShutdownSignals, handleUncaughtErrors } from '@anyone-protocol/service-kit';
import { startServer } from './app';
import { loadConfig } from './config';
import { HyperbeamNode } from './node';
import { ProcessIds } from './processes';
import { RateLimiter } from './rate-limit';
import { ReadHandler } from './reads';
import { MessageStore } from './store';
import { RolesCache, WriteHandler } from './writes';

const config = loadConfig();
const logger = createLogger({ service: 'hyperbeam-gateway', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

mkdirSync(dirname(config.MESSAGE_STORE_PATH), { recursive: true });
const store = new MessageStore(config.MESSAGE_STORE_PATH);
const node = new HyperbeamNode({ url: config.HB_URL, readTimeoutMs: config.NODE_READ_TIMEOUT, writeTimeoutMs: config.NODE_WRITE_TIMEOUT });
const processes = new ProcessIds({
  'operator-registry': config.OPERATOR_REGISTRY_PROCESS_ID,
  'relay-rewards': config.RELAY_REWARDS_PROCESS_ID,
  'staking-rewards': config.STAKING_REWARDS_PROCESS_ID,
});

const server = startServer({
  port: config.PORT,
  maxBodyBytes: config.MAX_BODY_BYTES,
  processes,
  reads: new ReadHandler({ node, store, cacheTtlMs: config.VIEW_CACHE_TTL }),
  writes: new WriteHandler({
    processes,
    node,
    store,
    admin: { actions: config.adminActions, signers: config.adminSigners },
    limiter: new RateLimiter({ perMinute: config.WRITES_PER_SIGNER_PER_MINUTE }),
    roles: new RolesCache(node, config.ROLES_CACHE_TTL),
    logger,
  }),
  logger,
});

logger.info('Listening', {
  port: server.port,
  operatorRegistryProcessId: config.OPERATOR_REGISTRY_PROCESS_ID,
  relayRewardsProcessId: config.RELAY_REWARDS_PROCESS_ID,
  stakingRewardsProcessId: config.STAKING_REWARDS_PROCESS_ID,
  adminActions: [...config.adminActions],
  adminSigners: config.adminSigners.size,
});

handleShutdownSignals(
  [
    ['http server', () => server.stop()],
    ['message store', () => store.close()],
  ],
  { logger },
);
