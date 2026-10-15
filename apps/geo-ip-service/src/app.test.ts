import { GeoIpClient, type GeoLocation } from '@anyone-protocol/geo-ip-client';
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { startServer } from './app';
import { ASN, CITY, type Edition, GeoDatabases } from './databases';

const TEST_DATA = join(import.meta.dir, '..', 'test-data');
const TEST_FILES: Record<Edition, string> = {
  [CITY]: join(TEST_DATA, 'GeoLite2-City-Test.mmdb'),
  [ASN]: join(TEST_DATA, 'GeoLite2-ASN-Test.mmdb'),
};

const LINKOPING: GeoLocation = {
  coordinates: { latitude: 58.4167, longitude: 15.6167 },
  countryCode: 'SE',
  countryName: 'Sweden',
  regionName: 'Östergötland County',
  cityName: 'Linköping',
  timeZone: 'Europe/Stockholm',
  asNumber: 29518,
  asName: 'Bredband2 AB',
};

const LINKOPING_H3 = {
  resolution: 4,
  cell: '8408b3dffffffff',
  center: { latitude: 58.40578421882332, longitude: 15.778067337833107 },
};

const SAN_DIEGO: GeoLocation = {
  coordinates: { latitude: 32.7203, longitude: -117.1552 },
  countryCode: 'US',
  countryName: 'United States',
  regionName: 'California',
  cityName: 'San Diego',
  timeZone: 'America/Los_Angeles',
};

const TELSTRA: GeoLocation = { asNumber: 1221, asName: 'Telstra Pty Ltd' };

let server: ReturnType<typeof startServer> | undefined;

async function serve({ editions = [CITY, ASN], maxBatchSize = 10 }: { editions?: Edition[]; maxBatchSize?: number } = {}) {
  const databases = new GeoDatabases();
  for (const edition of editions) {
    await databases.load(edition, TEST_FILES[edition]);
  }
  server = startServer({ port: 0, databases, maxBatchSize });
  return server;
}

function post(body: unknown) {
  return fetch(new URL('/lookup', server?.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(new URL(path, server?.url));
}

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

describe('POST /lookup', () => {
  it('answers every address in order, reporting unknown and invalid ones per item', async () => {
    await serve();

    const response = await post({ addresses: ['89.160.20.112', '2001:480::1', '1.128.0.1', '10.0.0.1', 'not-an-address', '89.160.20.112'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { address: '89.160.20.112', status: 'found', location: LINKOPING },
        { address: '2001:480::1', status: 'found', location: SAN_DIEGO },
        { address: '1.128.0.1', status: 'found', location: TELSTRA },
        { address: '10.0.0.1', status: 'not-found' },
        { address: 'not-an-address', status: 'invalid' },
        { address: '89.160.20.112', status: 'found', location: LINKOPING },
      ],
    });
  });

  it('adds the H3 cell and its center at the requested resolution to addresses with coordinates', async () => {
    await serve();

    const response = await post({ addresses: ['89.160.20.112', '1.128.0.1'], h3Resolution: 4 });

    expect(await response.json()).toEqual({
      results: [
        { address: '89.160.20.112', status: 'found', location: { ...LINKOPING, h3: LINKOPING_H3 } },
        { address: '1.128.0.1', status: 'found', location: TELSTRA },
      ],
    });
  });

  it.each([
    ['a body that is not JSON', '{"addresses": [', 400],
    ['a body without addresses', { h3Resolution: 4 }, 400],
    ['addresses that are not all strings', { addresses: ['89.160.20.112', 7] }, 400],
    ['an H3 resolution above 15', { addresses: ['89.160.20.112'], h3Resolution: 16 }, 400],
    ['an H3 resolution that is not an integer', { addresses: ['89.160.20.112'], h3Resolution: 4.5 }, 400],
    ['more addresses than the batch limit', { addresses: Array.from({ length: 11 }, () => '89.160.20.112') }, 413],
  ])('rejects %s', async (_, body, status) => {
    await serve();

    const response = await post(body);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });
});

describe('GET /lookup/:address', () => {
  it.each([
    ['an IPv4 address', '89.160.20.112', 200, { status: 'found', location: LINKOPING }],
    ['an IPv6 address', '2001:480::1', 200, { status: 'found', location: SAN_DIEGO }],
    ['an encoded IPv6 address', encodeURIComponent('2001:480::1'), 200, { status: 'found', location: SAN_DIEGO }],
    ['an address in no database', '10.0.0.1', 404, { status: 'not-found' }],
    ['something that is not an address', 'not-an-address', 400, { status: 'invalid' }],
  ])('answers %s', async (_, path, status, body) => {
    await serve();

    const response = await get(`/lookup/${path}`);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ address: decodeURIComponent(path), ...body });
  });

  it('adds the H3 cell when a resolution is given', async () => {
    await serve();

    expect(await (await get('/lookup/89.160.20.112?h3Resolution=4')).json()).toMatchObject({ location: { h3: LINKOPING_H3 } });
    expect((await get('/lookup/89.160.20.112?h3Resolution=x')).status).toBe(400);
  });
});

describe('geo-ip-client', () => {
  it('reads the same results the service answers', async () => {
    await serve();
    const client = new GeoIpClient({ baseUrl: server!.url.href, h3Resolution: 4 });

    const results = await client.lookupMany(['89.160.20.112', '10.0.0.1', 'not-an-address']);

    expect(Object.fromEntries(results)).toEqual({
      '89.160.20.112': { status: 'found', location: { ...LINKOPING, h3: LINKOPING_H3 }, stale: false },
      '10.0.0.1': { status: 'not-found', stale: false },
      'not-an-address': { status: 'invalid', stale: false },
    });
  });
});

describe('GET /healthz', () => {
  it('reports the build date and load time of each database', async () => {
    await serve();

    const response = await get('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'geo-ip-service',
      status: 'ok',
      checks: {
        [CITY]: { status: 'ok', buildDate: '2026-10-14T19:30:47.000Z', loadedAt: expect.any(String), lastError: null },
        [ASN]: { status: 'ok', buildDate: '2026-10-14T19:30:47.000Z', loadedAt: expect.any(String), lastError: null },
      },
    });
  });

  it('is degraded without the ASN database and still answers lookups', async () => {
    await serve({ editions: [CITY] });

    expect(await (await get('/healthz')).json()).toMatchObject({ status: 'degraded', checks: { [ASN]: { status: 'degraded' } } });
    expect((await get('/lookup/89.160.20.112')).status).toBe(200);
  });

  it('is down without the City database, and lookups are unavailable', async () => {
    await serve({ editions: [ASN] });

    expect((await get('/healthz')).status).toBe(503);
    expect((await get('/lookup/89.160.20.112')).status).toBe(503);
    expect((await post({ addresses: ['89.160.20.112'] })).status).toBe(503);
  });
});

describe('GET /metrics', () => {
  it('exposes database ages and lookup counts in the Prometheus text format', async () => {
    await serve({ editions: [CITY] });
    await post({ addresses: ['89.160.20.112', '10.0.0.1', 'not-an-address'] });
    await post({ addresses: 'none' });
    await get('/lookup/89.160.20.112');

    const response = await get('/metrics');
    const text = await response.text();

    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(text).toContain('geoip_database_loaded{edition="GeoLite2-City"} 1');
    expect(text).toContain('geoip_database_loaded{edition="GeoLite2-ASN"} 0');
    expect(text).toContain('geoip_database_load_failed{edition="GeoLite2-ASN"} 0');
    expect(text).toContain(`geoip_database_build_timestamp_seconds{edition="GeoLite2-City"} ${Date.parse('2026-10-14T19:30:47Z') / 1000}`);
    expect(text).toContain('geoip_lookups_total{status="found"} 2');
    expect(text).toContain('geoip_lookups_total{status="not-found"} 1');
    expect(text).toContain('geoip_lookups_total{status="invalid"} 1');
    expect(text).toContain('geoip_requests_total{route="batch",code="200"} 1');
    expect(text).toContain('geoip_requests_total{route="batch",code="400"} 1');
    expect(text).toContain('geoip_requests_total{route="single",code="200"} 1');
    expect(text).toContain('geoip_batch_duration_seconds_count 1');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('an unknown path', () => {
  it('is not found', async () => {
    await serve();

    expect((await get('/missing')).status).toBe(404);
  });
});
