import { createLogger, Secret } from '@anyone-protocol/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASN, CITY, databasePath, type Edition, GeoDatabases } from './databases';
import { MaxMindDownloads } from './maxmind-downloads';
import { editionArchive, makeArchive, type MaxMindStub, STUB_LICENSE_KEY, startMaxMindStub, TEST_DATABASE_FILES } from './testing/maxmind-stub';
import { DatabaseUpdater, UPDATE_RECORDS_FILE } from './updater';

const HOUR = 60 * 60 * 1000;
const BUILD = Date.parse('2026-10-14T19:30:47Z');

let stub: MaxMindStub;
let directory: string;
let clock: number;
let logLines: Record<string, unknown>[];

function updater({ databases = new GeoDatabases(() => clock), licensed = true, volume = directory } = {}) {
  const logger = createLogger({ service: 'geo-ip-service', write: (line) => logLines.push(JSON.parse(line)) });
  const downloads = new MaxMindDownloads({ baseUrl: stub.downloadUrl, licenseKey: new Secret(STUB_LICENSE_KEY) });
  return {
    databases,
    updater: new DatabaseUpdater({
      directory: volume,
      databases,
      downloads: licensed ? downloads : undefined,
      maxAgeMs: 72 * HOUR,
      minRequestIntervalMs: 12 * HOUR,
      logger,
      now: () => clock,
    }),
  };
}

async function restart() {
  const databases = new GeoDatabases(() => clock);
  await databases.loadAll(directory);
  return updater({ databases });
}

function requestsSince(count: number) {
  return stub.requests.slice(count).map(({ method, path, edition, suffix }) => (edition ? `${method} ${edition} ${suffix}` : `${method} ${path}`));
}

async function testDatabase(edition: Edition) {
  return Bun.file(TEST_DATABASE_FILES[edition]).bytes();
}

beforeEach(async () => {
  stub = await startMaxMindStub();
  directory = await mkdtemp(join(tmpdir(), 'geo-ip-updates-'));
  clock = BUILD + 24 * HOUR;
  logLines = [];
});

afterEach(async () => {
  await stub.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

describe('on an empty volume', () => {
  it('downloads every edition, installs it and serves it', async () => {
    const { updater: geo, databases } = updater();

    await geo.checkAll();

    expect(requestsSince(0)).toEqual([
      'HEAD GeoLite2-City tar.gz',
      'GET GeoLite2-City tar.gz.sha256',
      'GET GeoLite2-City tar.gz',
      'GET /files/GeoLite2-City.tar.gz',
      'HEAD GeoLite2-ASN tar.gz',
      'GET GeoLite2-ASN tar.gz.sha256',
      'GET GeoLite2-ASN tar.gz',
      'GET /files/GeoLite2-ASN.tar.gz',
    ]);
    expect(await readFile(databasePath(directory, CITY))).toEqual(Buffer.from(await testDatabase(CITY)));
    expect(databases.lookup('89.160.20.112')).toMatchObject({ status: 'found', location: { cityName: 'Linköping', asName: 'Bredband2 AB' } });
    expect(geo.status(CITY)).toMatchObject({ enabled: true, lastOutcome: 'downloaded', lastError: null });
  });

  it('gives the license key to MaxMind and not to the host it redirects to', async () => {
    await updater().updater.checkAll();

    const files = stub.requests.filter((request) => request.path.startsWith('/files/'));
    expect(files).toHaveLength(2);
    expect(files.every((request) => request.licenseKey === null)).toBe(true);
    expect(stub.requests.filter((request) => !request.path.startsWith('/files/')).every((request) => request.licenseKey === STUB_LICENSE_KEY)).toBe(true);
  });

  it('never contacts MaxMind without a license key', async () => {
    const { updater: geo } = updater({ licensed: false });

    await geo.checkAll();

    expect(stub.requests).toEqual([]);
    expect(geo.status(CITY)).toMatchObject({ enabled: false, nextCheckAfter: null });
  });
});

describe('with databases on the volume', () => {
  beforeEach(async () => {
    await updater().updater.checkAll();
  });

  it('does not contact MaxMind after a restart while the databases are younger than the maximum age', async () => {
    const before = stub.requests.length;
    const { updater: geo } = await restart();

    await geo.checkAll();
    clock = BUILD + 72 * HOUR - 1;
    await geo.checkAll();

    expect(requestsSince(before)).toEqual([]);
  });

  it('asks only with HEAD once a database is older than the maximum age and MaxMind has the same release', async () => {
    const before = stub.requests.length;
    const { updater: geo } = await restart();
    clock = BUILD + 72 * HOUR;

    await geo.checkAll();

    expect(requestsSince(before)).toEqual(['HEAD GeoLite2-City tar.gz', 'HEAD GeoLite2-ASN tar.gz']);
    expect(geo.status(CITY)).toMatchObject({ lastOutcome: 'unchanged', nextCheckAfter: new Date(clock + 12 * HOUR).toISOString() });
  });

  it('compares the checksum instead when HEAD gives no release date', async () => {
    const before = stub.requests.length;
    stub.override((request) => (request.method === 'HEAD' ? new Response(null, { status: 302, headers: { location: '/files/elsewhere' } }) : undefined));
    const { updater: geo } = await restart();
    clock = BUILD + 72 * HOUR;

    await geo.checkAll();

    expect(requestsSince(before)).toEqual(['HEAD GeoLite2-City tar.gz', 'GET GeoLite2-City tar.gz.sha256', 'HEAD GeoLite2-ASN tar.gz', 'GET GeoLite2-ASN tar.gz.sha256']);
    expect(geo.status(CITY).lastOutcome).toBe('unchanged');
  });

  it('waits the minimum request interval before asking MaxMind again, across restarts', async () => {
    clock = BUILD + 72 * HOUR;
    await (await restart()).updater.checkAll();
    const before = stub.requests.length;

    clock += 12 * HOUR - 1;
    await (await restart()).updater.checkAll();
    expect(requestsSince(before)).toEqual([]);

    clock += 1;
    await (await restart()).updater.checkAll();
    expect(requestsSince(before)).toHaveLength(2);
  });

  it('downloads a new release and swaps it in without failing a lookup', async () => {
    const { updater: geo, databases } = await restart();
    stub.publish(CITY, editionArchive(CITY, await testDatabase(CITY), '20261017'));
    clock = BUILD + 72 * HOUR;

    let stopped = false;
    const results: string[] = [];
    const lookups = (async () => {
      while (!stopped) {
        results.push(databases.lookup('89.160.20.112').status);
        await Bun.sleep(0);
      }
    })();
    await geo.checkAll();
    stopped = true;
    await lookups;

    expect(geo.status(CITY).lastOutcome).toBe('downloaded');
    expect(geo.status(ASN).lastOutcome).toBe('unchanged');
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((status) => status === 'found')).toBe(true);
  });

  it('downloads every edition when forced, whatever their age', async () => {
    const before = stub.requests.length;
    const { updater: geo } = await restart();

    await geo.update(CITY, { force: true });

    expect(requestsSince(before)).toEqual(['HEAD GeoLite2-City tar.gz', 'GET GeoLite2-City tar.gz.sha256', 'GET GeoLite2-City tar.gz', 'GET /files/GeoLite2-City.tar.gz']);
  });

  describe('when an update fails', () => {
    const failures: [string, (stub: MaxMindStub) => Promise<void> | void, string][] = [
      ['MaxMind refuses the license key', (s) => s.override(() => new Response('Invalid license key', { status: 401 })), 'MaxMind answered 401 to HEAD for GeoLite2-City tar.gz'],
      ['MaxMind limits the rate', (s) => s.override(() => new Response('Too many requests', { status: 429 })), 'MaxMind answered 429'],
      ['MaxMind fails', (s) => s.override(() => new Response('', { status: 500 })), 'MaxMind answered 500'],
      ['MaxMind is unreachable', (s) => s.server.stop(true), 'MaxMind HEAD for GeoLite2-City tar.gz failed'],
      [
        'the archive does not match its checksum',
        async (s) => {
          s.publish(CITY, editionArchive(CITY, await testDatabase(CITY), '20261017'));
          s.override((_, url) => (url.pathname.startsWith('/files/') ? new Response(makeArchive({})) : undefined));
        },
        'does not match the published',
      ],
      ['the archive holds no database', (s) => s.publish(CITY, makeArchive({ 'GeoLite2-City_20261017/README.txt': new Uint8Array(1) })), 'archive holds no GeoLite2-City.mmdb'],
      ['the archive holds another edition', async (s) => s.publish(CITY, editionArchive(CITY, await testDatabase(ASN))), 'database holds GeoLite2-ASN, expected GeoLite2-City'],
      ['the database is corrupt', (s) => s.publish(CITY, editionArchive(CITY, new Uint8Array(4096).fill(7))), ''],
    ];

    it.each(failures)('keeps serving the installed database when %s', async (_, breakStub, error) => {
      const installed = await readFile(databasePath(directory, CITY));
      const { updater: geo, databases } = await restart();
      await breakStub(stub);
      clock = BUILD + 72 * HOUR;

      await geo.update(CITY);

      expect(geo.status(CITY)).toMatchObject({ lastOutcome: 'failed', lastError: expect.stringContaining(error) });
      expect(databases.lookup('89.160.20.112')).toMatchObject({ status: 'found' });
      expect(await readFile(databasePath(directory, CITY))).toEqual(installed);
      expect(geo.renderMetrics()).toContain('geoip_update_requests_total{edition="GeoLite2-City",outcome="failed"} 1');
      expect(logLines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'Database update failed', edition: CITY }));
      expect(JSON.stringify(logLines)).not.toContain(STUB_LICENSE_KEY);
    });

    it('refuses a release older than the loaded database', async () => {
      class LaterDatabases extends GeoDatabases {
        override buildDate() {
          return new Date('2030-01-01T00:00:00Z');
        }
      }
      const { updater: geo } = updater({ databases: new LaterDatabases() });

      await geo.update(CITY, { force: true });

      expect(geo.status(CITY).lastError).toContain('is older than the loaded 2030-01-01T00:00:00.000Z');
    });

    it('keeps the license key out of the logs even when MaxMind repeats it', async () => {
      stub.override((request) => (request.method === 'GET' ? new Response(`Invalid license key ${STUB_LICENSE_KEY}`, { status: 401 }) : undefined));
      const { updater: geo } = await restart();

      await geo.update(CITY, { force: true });

      expect(JSON.stringify(logLines)).not.toContain(STUB_LICENSE_KEY);
      expect(JSON.stringify(logLines)).toContain('Invalid license key [redacted]');
    });
  });
});

describe('two allocations sharing a volume', () => {
  it('install the same release side by side without leaving a broken or temporary file', async () => {
    const first = updater();
    const second = updater();

    const records = await Promise.all([first.updater.update(CITY, { force: true }), second.updater.update(CITY, { force: true })]);

    expect(records.map((record) => record.lastOutcome)).toEqual(['downloaded', 'downloaded']);

    expect(await readFile(databasePath(directory, CITY))).toEqual(Buffer.from(await testDatabase(CITY)));
    expect((await readdir(directory)).sort()).toEqual(['GeoLite2-City.mmdb', UPDATE_RECORDS_FILE]);
  });
});

describe('update records', () => {
  it('keeps the minimum request interval when the volume cannot be written', async () => {
    const volume = join(directory, 'not-a-directory');
    await Bun.write(volume, '');
    const { updater: geo } = updater({ volume });

    await geo.checkAll();
    expect(geo.status(CITY).lastOutcome).toBe('failed');
    expect(logLines).toContainEqual(expect.objectContaining({ level: 'error', message: 'Update records could not be written' }));
    const before = stub.requests.length;

    clock += 12 * HOUR - 1;
    await geo.checkAll();
    expect(requestsSince(before)).toEqual([]);

    clock += 1;
    await geo.checkAll();
    expect(requestsSince(before)).toHaveLength(8);
  });

  it('starts from no records when the file is unreadable', async () => {
    await Bun.write(join(directory, UPDATE_RECORDS_FILE), 'not json');
    const { updater: geo } = updater();

    await geo.checkAll();

    expect(geo.status(CITY).lastOutcome).toBe('downloaded');
    expect(logLines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'Update records unreadable' }));
  });
});
