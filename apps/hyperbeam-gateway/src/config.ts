import { commonEnv, type Environment, env, parseEnv } from '@anyone-protocol/service-kit';
import { ADMIN_ACTION_KEYS } from './actions';
import { isChecksumAddress } from './ans104';
import { PROCESS_ID } from './processes';

export const gatewayEnv = {
  ...commonEnv,
  HB_URL: env.url(),
  OPERATOR_REGISTRY_PROCESS_ID: env.string(),
  RELAY_REWARDS_PROCESS_ID: env.string(),
  STAKING_REWARDS_PROCESS_ID: env.string(),
  ADMIN_ACTIONS: env.string({ default: '' }),
  ADMIN_SIGNERS: env.string({ default: '' }),
  MESSAGE_STORE_PATH: env.string({ default: 'data/messages.sqlite' }),
  VIEW_CACHE_TTL: env.durationMs({ default: 30_000 }),
  ROLES_CACHE_TTL: env.durationMs({ default: 30_000 }),
  NODE_READ_TIMEOUT: env.durationMs({ default: 30_000 }),
  NODE_WRITE_TIMEOUT: env.durationMs({ default: 60_000 }),
  MAX_BODY_BYTES: env.integer({ default: 1_048_576 }),
  WRITES_PER_SIGNER_PER_MINUTE: env.integer({ default: 20 }),
};

export type GatewayConfig = ReturnType<typeof loadConfig>;

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export function loadConfig(source: Environment = process.env) {
  const config = parseEnv(gatewayEnv, source);
  const adminActions = list(config.ADMIN_ACTIONS);
  const adminSigners = list(config.ADMIN_SIGNERS);
  const processIds = [config.OPERATOR_REGISTRY_PROCESS_ID, config.RELAY_REWARDS_PROCESS_ID, config.STAKING_REWARDS_PROCESS_ID];

  const problems = [
    ...(['OPERATOR_REGISTRY_PROCESS_ID', 'RELAY_REWARDS_PROCESS_ID', 'STAKING_REWARDS_PROCESS_ID'] as const).map((name) => !PROCESS_ID.test(config[name]) && `${name} must be a 43 character process id`),
    new Set(processIds).size !== processIds.length && 'process ids must be distinct',
    ...adminActions.map((key) => !ADMIN_ACTION_KEYS.has(key) && `ADMIN_ACTIONS entry ${key} is not a known admin action, expected one of ${[...ADMIN_ACTION_KEYS].join(', ')}`),
    ...adminSigners.map((address) => !isChecksumAddress(address) && `ADMIN_SIGNERS entry ${address} must be a checksummed address`),
    adminActions.length > 0 && adminSigners.length === 0 && 'ADMIN_ACTIONS needs at least one ADMIN_SIGNERS entry',
    ...(['MAX_BODY_BYTES', 'WRITES_PER_SIGNER_PER_MINUTE', 'VIEW_CACHE_TTL', 'ROLES_CACHE_TTL', 'NODE_READ_TIMEOUT', 'NODE_WRITE_TIMEOUT'] as const).map(
      (name) => config[name] <= 0 && `${name} must be greater than 0`,
    ),
  ].filter(Boolean);

  if (problems.length > 0) {
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  return { ...config, adminActions: new Set(adminActions), adminSigners: new Set(adminSigners) };
}
