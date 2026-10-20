import { GeoIpClient, type GeoLocation } from '@anyone-protocol/geo-ip-client';
import { createLogger } from '@anyone-protocol/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cellToBoundary } from 'h3-js';
import { startServer } from './app';
import { Onionoo, type Relay } from './onionoo';
import { OperatorRegistry } from './operator-registry';
import { StubGeoIpService, StubUpstreams } from './testing/stubs';
import { type AnyoneDomain, UnsDomains, type UnsTokenRow } from './uns-domains';
import { type QueryResponse, RelayMetrics, type SampleValue, VictoriaMetrics } from './victoria-metrics';

const HOUR = 60 * 60 * 1000;
const PROCESS_ID = 'operator-registry-process-id';

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
const LINKOPING_CELL = '8408b3dffffffff';
const LINKOPING_CENTER = [58.40578421882332, 15.778067337833107];

const LOCATIONS: Record<string, GeoLocation> = {
  '89.160.20.112': LINKOPING,
  '1.128.0.1': { asNumber: 1221, asName: 'Telstra Pty Ltd' },
  '192.0.2.1': { coordinates: { latitude: 0, longitude: 15.6167 }, countryCode: 'SE' },
};

function relay(fingerprint: string, address: string, extra: Partial<Relay> = {}): Relay {
  return {
    fingerprint,
    nickname: `relay${fingerprint.slice(0, 4)}`,
    running: true,
    consensus_weight: 20,
    observed_bandwidth: 1000,
    measured: true,
    or_addresses: [`${address}:9001`, '[2001:db8::1]:9001'],
    ...extra,
  };
}

const RELAYS = [
  relay('A'.repeat(40), '89.160.20.112'),
  relay('B'.repeat(40), '89.160.20.112', { running: false }),
  relay('C'.repeat(40), '1.128.0.1'),
  relay('D'.repeat(40), '10.0.0.1'),
  relay('E'.repeat(40), '192.0.2.1'),
];

const DOMAINS: UnsTokenRow[] = [
  { tokenId: '1', name: 'first.anyone', owner: '0xAbC0000000000000000000000000000000000001' },
  { tokenId: '2', name: 'second.anyone', owner: '0x0000000000000000000000000000000000000002' },
];

function vector(metric: string, values: Record<string, string>): QueryResponse {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: Object.entries(values).map(([status, value]) => ({ metric: { __name__: metric, status }, value: [1712316485, value], values: [] })),
    },
  };
}

function matrix(metric: string, values: Record<string, SampleValue[]>): QueryResponse {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: Object.entries(values).map(([status, samples]) => ({ metric: { __name__: metric, status }, value: [0, ''], values: samples })),
    },
  };
}

let upstreams: StubUpstreams;
let geoIpService: StubGeoIpService;
let server: ReturnType<typeof startServer>;
let clock: number;
let domainRows: () => Promise<UnsTokenRow[]>;

function serve() {
  const logger = createLogger({ service: 'api-service', write: () => {} });
  server = startServer({
    port: 0,
    onionoo: new Onionoo({ baseUrl: upstreams.url, cacheTtlMs: 0, timeoutMs: 1000 }),
    relayMetrics: new RelayMetrics(
      new VictoriaMetrics(upstreams.url),
      { cluster: 'local', env: 'main', instance: upstreams.address, job: 'consulagentonionoo' },
      { from: '-7d', to: 'now', interval: '6h' },
    ),
    geo: new GeoIpClient({ baseUrl: geoIpService.server.url.href, cacheTtlMs: HOUR, retryAfterFailureMs: 0, now: () => clock }),
    hexagonResolution: 4,
    operatorRegistry: new OperatorRegistry({ nodeUrl: upstreams.url, processId: PROCESS_ID, cacheTtlMs: 0, logger, read: { retryDelayMs: 1 } }),
    unsDomains: new UnsDomains({ rows: () => domainRows(), cacheTtlMs: 0, logger }),
    logger,
  });
  return server;
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(new URL(path, server.url), { headers });
}

function post(path: string, body: string, contentType = 'application/json') {
  return fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': contentType }, body });
}

async function stopGeoIpService() {
  await geoIpService.server.stop(true);
}

beforeEach(() => {
  upstreams = new StubUpstreams();
  upstreams.details = { relays: RELAYS };
  geoIpService = new StubGeoIpService(LOCATIONS);
  clock = 0;
  domainRows = async () => DOMAINS;
  serve();
});

afterEach(async () => {
  await server.stop(true);
  await upstreams.server.stop(true);
  await stopGeoIpService();
});

describe('relay metrics', () => {
  const latest: [string, string, Record<string, string>][] = [
    ['/total-relays-latest', 'total_relays', { all: '43', offline: '26', online: '17' }],
    ['/total-observed-bandwidth-latest', 'total_observed_bandwidth', { all: '43138495', offline: '3738891', online: '39399604' }],
    ['/average-bandwidth-rate-latest', 'average_bandwidth_rate', { all: '508379136', offline: '9402231.466666667', online: '948652875.2941176' }],
  ];

  it.each(latest)('GET %s answers the latest value per status', async (path, metric, values) => {
    upstreams.query = vector(metric, values);

    const response = await get(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(values);
    expect(upstreams.requestsTo('/api/v1/query')[0]?.params).toEqual({
      query: `${metric}{cluster="local", env="main", instance="${upstreams.address}", job="consulagentonionoo"}`,
    });
  });

  const ranges: [string, string, Record<string, SampleValue[]>][] = [
    ['/total-relays', 'total_relays', { all: [[1712316678, '43'], [1712316978, '44']], offline: [[1712316678, '26'], [1712316978, '27']], online: [[1712316678, '17'], [1712316978, '18']] }],
    ['/total-observed-bandwidth', 'total_observed_bandwidth', { all: [[1712497652, '43138495'], [1712497952, '43138495']], offline: [[1712497652, '3738891'], [1712497952, '3738891']], online: [[1712497652, '39399604'], [1712497952, '39399604']] }],
    ['/average-bandwidth-rate', 'average_bandwidth_rate', { all: [[1712497700, '508379136'], [1712498000, '508379136']], offline: [[1712497700, '9402231.466666667'], [1712498000, '9402231.466666667']], online: [[1712497700, '948652875.2941176'], [1712498000, '948652875.2941176']] }],
  ];

  it.each(ranges)('GET %s answers the samples per status over the default range', async (path, metric, values) => {
    upstreams.queryRange = matrix(metric, values);

    const response = await get(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(values);
    expect(upstreams.requestsTo('/api/v1/query_range')[0]?.params).toMatchObject({ start: '-7d', end: 'now', step: '6h' });
  });

  it('passes from, to and interval through as start, end and step', async () => {
    await get('/total-relays?from=3d&to=now&interval=12h');

    expect(upstreams.requestsTo('/api/v1/query_range')[0]?.params).toMatchObject({ start: '3d', end: 'now', step: '12h' });
  });

  it('answers 500 when VictoriaMetrics fails', async () => {
    upstreams.failWith = 500;

    const response = await get('/total-relays-latest');

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Error querying VictoriaMetrics');
  });
});

describe('GET /relays/:fingerprint', () => {
  it('answers the relay summary', async () => {
    const response = await get(`/relays/${'B'.repeat(40)}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nickname: 'relayBBBB', fingerprint: 'B'.repeat(40), running: false, consensus_weight: 20, observed_bandwidth: 1000, measured: true });
  });

  it('asks Onionoo only for the fields the service reads', async () => {
    await get(`/relays/${'A'.repeat(40)}`);

    expect(upstreams.requestsTo('/details')[0]?.params).toEqual({ fields: 'fingerprint,nickname,running,consensus_weight,observed_bandwidth,measured,or_addresses' });
  });

  it('answers 404 for an unknown relay', async () => {
    const response = await get(`/relays/${'F'.repeat(40)}`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('Relay not found');
  });

  it('answers 500 when Onionoo fails', async () => {
    upstreams.failWith = 503;

    const response = await get(`/relays/${'A'.repeat(40)}`);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Error querying Onionoo');
  });
});

describe('GET /relays', () => {
  it('answers the summaries of the known relays among the fingerprints', async () => {
    const response = await get(`/relays?fingerprints=${'C'.repeat(40)},${'F'.repeat(40)},${'A'.repeat(40)}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as Relay[]).map((summary) => summary.fingerprint)).toEqual(['A'.repeat(40), 'C'.repeat(40)]);
  });

  it.each(['/relays', '/relays?fingerprints='])('answers 400 to %s', async (path) => {
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Fingerprints are required');
    expect(upstreams.requestsTo('/details')).toHaveLength(0);
  });
});

describe('GET /relay-map/', () => {
  it('counts relays per H3 cell, skipping relays without usable coordinates', async () => {
    const response = await get('/relay-map/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ index: LINKOPING_CELL, relayCount: 2, geo: LINKOPING_CENTER, boundary: cellToBoundary(LINKOPING_CELL) }]);
  });

  it('looks up the first OR address of every relay once, with the port removed', async () => {
    await get('/relay-map/');

    expect(geoIpService.requests).toEqual([{ addresses: ['89.160.20.112', '1.128.0.1', '10.0.0.1', '192.0.2.1'] }]);
  });
});

describe('GET /fingerprint-map/', () => {
  it('answers the cell and geolocation of every relay with usable coordinates', async () => {
    const response = await get('/fingerprint-map/');
    const location = {
      hexId: LINKOPING_CELL,
      coordinates: LINKOPING_CENTER,
      countryCode: 'SE',
      countryName: 'Sweden',
      regionName: 'Östergötland County',
      cityName: 'Linköping',
      asNumber: '29518',
      asName: 'Bredband2 AB',
    };

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ ['A'.repeat(40)]: location, ['B'.repeat(40)]: location }));
  });
});

describe('when geo-ip-service is down', () => {
  it('keeps serving both maps from the cache and reports degraded health', async () => {
    const relayMap = await (await get('/relay-map/')).text();
    const fingerprintMap = await (await get('/fingerprint-map/')).text();
    await stopGeoIpService();
    clock += 2 * HOUR;

    const relayMapResponse = await get('/relay-map/');
    const fingerprintMapResponse = await get('/fingerprint-map/');
    const health = await get('/healthz');

    expect(relayMapResponse.status).toBe(200);
    expect(await relayMapResponse.text()).toBe(relayMap);
    expect(fingerprintMapResponse.status).toBe(200);
    expect(await fingerprintMapResponse.text()).toBe(fingerprintMap);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'degraded', checks: { geoIp: { status: 'degraded', failing: true, entries: 4, expiredEntries: 4 } } });
  });

  it('answers 503 for both maps on a cold start and serves every other route', async () => {
    await stopGeoIpService();

    for (const path of ['/relay-map/', '/fingerprint-map/']) {
      const response = await get(path);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Relay geolocation is unavailable');
    }
    for (const path of [`/relays/${'A'.repeat(40)}`, `/relays?fingerprints=${'A'.repeat(40)}`, '/total-relays', '/total-relays-latest', '/operators', '/anyone-domains', '/healthz']) {
      expect((await get(path)).status).toBe(200);
    }
    expect(await (await get('/healthz')).json()).toMatchObject({ status: 'degraded', checks: { geoIp: { failing: true, entries: 0 } } });
  });
});

describe('POST /hardware', () => {
  const hardwareInfo = {
    id: 'id',
    company: 'company',
    format: 'format',
    wallet: '0x0000000000000000000000000000000000000001',
    fingerprint: 'A'.repeat(40),
    nftid: '1',
    build: 'build',
    flags: 'flags',
    serNums: [{ type: 'type', number: '1' }],
    pubKeys: [{ type: 'type', number: '1' }],
    certs: [{ type: 'type', signature: 'signature' }],
  };

  it('puts valid hardware info to Onionoo and relays its answer', async () => {
    upstreams.hardwareAnswer = `Hardware relay info is updated. Fingerprint: ${'A'.repeat(40)}`;

    const response = await post('/hardware', JSON.stringify(hardwareInfo));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(upstreams.hardwareAnswer);
    expect(upstreams.requestsTo(`/hardware/${'A'.repeat(40)}`)).toMatchObject([{ method: 'PUT', body: JSON.stringify(hardwareInfo) }]);
  });

  it('answers 400 with every validation error and does not call Onionoo', async () => {
    const response = await post('/hardware', JSON.stringify({ ...hardwareInfo, fingerprint: 'xyz', serNums: [{ type: '' }] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: [
        { type: 'field', value: 'xyz', msg: 'fingerprint must be a 40 character hexadecimal string', path: 'fingerprint', location: 'body' },
        { type: 'field', value: '', msg: 'serNums.*.type should not be empty', path: 'serNums[0].type', location: 'body' },
        { type: 'field', msg: 'serNums.*.number should not be empty', path: 'serNums[0].number', location: 'body' },
      ],
    });
    expect(upstreams.requests).toHaveLength(0);
  });

  it('validates a body that is not JSON as empty', async () => {
    const response = await post('/hardware', JSON.stringify(hardwareInfo), 'text/plain');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: unknown[] }).errors).toHaveLength(12);
  });

  it.each(['{bad', '"text"'])('answers 400 without CORS to the malformed JSON %s', async (body) => {
    const response = await post('/hardware', body);

    expect(response.status).toBe(400);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.text()).toContain('<pre>Bad Request</pre>');
  });

  it('answers 500 when Onionoo fails', async () => {
    upstreams.failWith = 500;

    const response = await post('/hardware', JSON.stringify(hardwareInfo));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Error posting hardware info');
  });
});

describe('GET /operators', () => {
  beforeEach(() => {
    upstreams.operators = { '0xabc0000000000000000000000000000000000001': true, '0x0000000000000000000000000000000000000003': true };
  });

  it('answers the operator addresses from the registry view', async () => {
    const response = await get('/operators');

    expect(await response.json()).toEqual(['0xabc0000000000000000000000000000000000001', '0x0000000000000000000000000000000000000003']);
    expect(upstreams.requestsTo(`/${PROCESS_ID}~process@1.0/as/operators`)).toHaveLength(1);
  });

  it('adds the domains each operator owns, matching addresses without case', async () => {
    const response = await get('/operators?withDomains=true');

    expect(await response.json()).toEqual([
      { address: '0xabc0000000000000000000000000000000000001', domains: [{ ...DOMAINS[0], tld: 'anyone' }] },
      { address: '0x0000000000000000000000000000000000000003', domains: [] },
    ]);
  });
});

describe('GET /anyone-domains', () => {
  it('answers every domain from the UNS indexer database', async () => {
    const response = await get('/anyone-domains');

    expect(await response.json()).toEqual(DOMAINS.map((domain): AnyoneDomain => ({ ...domain, tld: 'anyone' })));
  });

  it('answers an empty list when the database fails before anything was cached', async () => {
    domainRows = () => Promise.reject(new Error('connection refused'));

    expect(await (await get('/anyone-domains')).json()).toEqual([]);
  });
});

describe('Express compatibility', () => {
  it('allows any origin and sets a weak ETag on every route answer', async () => {
    upstreams.query = vector('total_relays', { all: '43', offline: '26', online: '17' });

    const response = await get('/total-relays-latest');

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('etag')).toBe('W/"29-YTBg3dm+05TH93CiOxEfpumF2I8"');
  });

  it('answers 304 when If-None-Match holds the current ETag', async () => {
    const etag = (await get(`/relays/${'A'.repeat(40)}`)).headers.get('etag') ?? '';

    const response = await get(`/relays/${'A'.repeat(40)}`, { 'if-none-match': etag });

    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(etag);
    expect(await response.text()).toBe('');
  });

  it('serves every route with and without a trailing slash', async () => {
    for (const path of ['/relay-map', '/fingerprint-map', `/relays/${'A'.repeat(40)}/`, `/relays/?fingerprints=${'A'.repeat(40)}`, '/operators/', '/total-relays-latest/']) {
      expect((await get(path)).status).toBe(200);
    }
  });

  it('answers a CORS preflight on any path', async () => {
    const response = await fetch(new URL('/relays', server.url), { method: 'OPTIONS', headers: { origin: 'https://example.org', 'access-control-request-headers': 'content-type' } });

    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
      'access-control-allow-headers': 'content-type',
      vary: 'Access-Control-Request-Headers',
    });
  });

  it.each([
    ['GET', '/missing$x'],
    ['POST', '/relays'],
  ])('answers %s %s with the Express not found page', async (method, path) => {
    const response = await fetch(new URL(path, server.url), { method });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.text()).toBe(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${method} ${path}</pre>\n</body>\n</html>\n`);
  });
});

describe('GET /healthz', () => {
  it('reports the service as ok', async () => {
    const response = await get('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'api-service', status: 'ok', checks: { geoIp: { status: 'ok', failing: false } } });
  });
});
