import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ASN, CITY, databasePath, GeoDatabases } from './databases';

const TEST_DATA = join(import.meta.dir, '..', 'test-data');
const CITY_TEST = join(TEST_DATA, 'GeoLite2-City-Test.mmdb');
const ASN_TEST = join(TEST_DATA, 'GeoLite2-ASN-Test.mmdb');

describe('databasePath', () => {
  it('names the file after the edition', () => {
    expect(databasePath('/var/lib/geoip', CITY)).toBe('/var/lib/geoip/GeoLite2-City.mmdb');
  });
});

describe('GeoDatabases', () => {
  it('reports the build date and load time of a loaded edition', async () => {
    const databases = new GeoDatabases(() => Date.UTC(2030, 0, 1));

    expect(await databases.load(CITY, CITY_TEST)).toEqual({
      edition: CITY,
      loaded: true,
      buildDate: '2026-10-14T19:30:47.000Z',
      loadedAt: '2030-01-01T00:00:00.000Z',
      lastError: null,
    });
    expect(databases.ready).toBe(true);
  });

  it('is not ready until the City edition is loaded', async () => {
    const databases = new GeoDatabases();

    await databases.load(ASN, ASN_TEST);

    expect(databases.ready).toBe(false);
  });

  it.each([
    ['a missing file', join(TEST_DATA, 'missing.mmdb'), 'ENOENT'],
    ['a file of another edition', ASN_TEST, 'holds GeoLite2-ASN, expected GeoLite2-City'],
    ['a file that is not a database', import.meta.path, ''],
  ])('reports %s as not loaded', async (_, path, error) => {
    const state = await new GeoDatabases().load(CITY, path);

    expect(state).toMatchObject({ loaded: false, buildDate: null, lastError: expect.stringContaining(error) });
  });

  it('keeps answering from the loaded edition when a later load fails', async () => {
    const databases = new GeoDatabases();
    await databases.load(CITY, CITY_TEST);

    const state = await databases.load(CITY, ASN_TEST);

    expect(state).toMatchObject({ loaded: true, lastError: expect.stringContaining('expected GeoLite2-City') });
    expect(databases.lookup('89.160.20.112')).toMatchObject({ status: 'found', location: { cityName: 'Linköping' } });
  });

  it('answers an IPv4-mapped IPv6 address like the IPv4 address', async () => {
    const databases = new GeoDatabases();
    await databases.load(CITY, CITY_TEST);

    expect(databases.lookup('::ffff:89.160.20.112')).toEqual(databases.lookup('89.160.20.112'));
  });
});
