import { commonEnv, type Environment, env, parseEnv } from '@anyone-protocol/service-kit';

const MAX_H3_RESOLUTION = 15;

export const apiServiceEnv = {
  ...commonEnv,
  ONIONOO_INSTANCE: env.string(),
  ONIONOO_PROTOCOL: env.string({ default: 'http://' }),
  ONIONOO_DETAILS_CACHE_TTL_SECONDS: env.integer({ default: 60 }),
  ONIONOO_DETAILS_TIMEOUT_SECONDS: env.integer({ default: 30 }),
  VICTORIA_METRICS_ADDRESS: env.url(),
  CLUSTER: env.string({ default: 'local' }),
  ENV: env.string({ default: 'main' }),
  JOB: env.string({ default: 'consulagentonionoo' }),
  FROM: env.string({ default: '-7d' }),
  TO: env.string({ default: 'now' }),
  INTERVAL: env.string({ default: '6h' }),
  HEXAGON_RESOLUTION: env.integer({ default: 4 }),
  GEO_IP_SERVICE_URL: env.url(),
  GEO_IP_CACHE_TTL: env.durationMs({ default: 60 * 60 * 1000 }),
  HB_URL: env.url(),
  OPERATOR_REGISTRY_PROCESS_ID: env.string(),
  OPERATOR_REGISTRY_CACHE_TTL_SECONDS: env.integer({ default: 0 }),
  DB_HOST: env.string(),
  DB_PORT: env.integer({ default: 5432 }),
  DB_USER: env.string(),
  DB_PASS: env.secret(env.string({ optional: true })),
  DB_NAME: env.string(),
  UNS_DOMAINS_CACHE_TTL_SECONDS: env.integer({ default: 30 }),
};

export type ApiServiceConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: Environment = process.env) {
  const config = parseEnv(apiServiceEnv, source);
  const problems = [
    (config.HEXAGON_RESOLUTION < 0 || config.HEXAGON_RESOLUTION > MAX_H3_RESOLUTION) && `HEXAGON_RESOLUTION must be from 0 to ${MAX_H3_RESOLUTION}`,
    config.ONIONOO_DETAILS_TIMEOUT_SECONDS <= 0 && 'ONIONOO_DETAILS_TIMEOUT_SECONDS must be greater than 0',
    ...(['ONIONOO_DETAILS_CACHE_TTL_SECONDS', 'OPERATOR_REGISTRY_CACHE_TTL_SECONDS', 'UNS_DOMAINS_CACHE_TTL_SECONDS'] as const).map(
      (name) => config[name] < 0 && `${name} must not be negative`,
    ),
  ].filter(Boolean);

  if (problems.length > 0) {
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  return config;
}
