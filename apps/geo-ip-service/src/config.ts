import { env } from '@anyone-protocol/service-kit';
import { MAXMIND_DOWNLOAD_URL } from './maxmind-downloads';

const HOUR_MS = 60 * 60 * 1000;

export const maxMindEnv = {
  GEOIP_DATA_DIR: env.string(),
  MAXMIND_LICENSE_KEY: env.secret(env.string({ optional: true })),
  MAXMIND_DOWNLOAD_URL: env.url({ default: MAXMIND_DOWNLOAD_URL }),
};

export const updateScheduleEnv = {
  GEOIP_CHECK_INTERVAL: env.durationMs({ default: HOUR_MS }),
  GEOIP_MAX_AGE: env.durationMs({ default: 72 * HOUR_MS }),
  MAXMIND_MIN_REQUEST_INTERVAL: env.durationMs({ default: 12 * HOUR_MS }),
};
