import { createLogger, handleUncaughtErrors, LOG_LEVELS, env, parseEnv } from '@anyone-protocol/service-kit';
import { parseArgs } from 'node:util';
import { maxMindEnv } from './config';
import { EDITIONS, type Edition, GeoDatabases } from './databases';
import { MaxMindDownloads } from './maxmind-downloads';
import { DatabaseUpdater } from './updater';

const USAGE = `Downloads the GeoLite2 databases from MaxMind once, checks them and installs them.

Usage: bun apps/geo-ip-service/src/update.ts [--dir <directory>] [--edition <edition>]...

  --dir      directory to install into, default GEOIP_DATA_DIR
  --edition  edition to download, ${EDITIONS.join(' or ')}; repeat for both, default both

Reads MAXMIND_LICENSE_KEY and MAXMIND_DOWNLOAD_URL like the service. Ignores the
update schedule and always downloads. A running service picks the new files up on SIGHUP.`;

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    edition: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const config = parseEnv({
  ...maxMindEnv,
  GEOIP_DATA_DIR: env.string({ optional: true }),
  LOG_LEVEL: env.oneOf(LOG_LEVELS, { default: 'info' }),
});
const logger = createLogger({ service: 'geo-ip-service-update', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const directory = values.dir ?? config.GEOIP_DATA_DIR;
const editions = (values.edition ?? EDITIONS) as Edition[];
const unknown = editions.filter((edition) => !EDITIONS.includes(edition));
const licenseKey = config.MAXMIND_LICENSE_KEY;
if (!directory || unknown.length > 0 || !licenseKey) {
  console.error(!directory ? 'Set --dir or GEOIP_DATA_DIR.' : unknown.length > 0 ? `Unknown edition: ${unknown.join(', ')}.` : 'Set MAXMIND_LICENSE_KEY.');
  console.error(`\n${USAGE}`);
  process.exit(2);
}

const databases = new GeoDatabases();
await databases.loadAll(directory);
const updater = new DatabaseUpdater({
  directory,
  databases,
  downloads: new MaxMindDownloads({ baseUrl: config.MAXMIND_DOWNLOAD_URL, licenseKey }),
  maxAgeMs: 0,
  minRequestIntervalMs: 0,
  logger,
});

let failed = false;
for (const edition of editions) {
  const record = await updater.update(edition, { force: true });
  failed ||= record.lastOutcome === 'failed';
}
process.exit(failed ? 1 : 0);
