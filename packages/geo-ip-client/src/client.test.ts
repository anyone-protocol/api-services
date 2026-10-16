import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GeoIpClient, type GeoIpClientOptions } from './client';
import type { BatchLookupRequest, GeoLocation } from './protocol';

const SYDNEY: GeoLocation = { coordinates: { latitude: -33.86, longitude: 151.2 }, countryCode: 'AU', asNumber: 13335 };
const BERLIN: GeoLocation = { coordinates: { latitude: 52.52, longitude: 13.4 }, countryCode: 'DE', asNumber: 24940 };
const LOCATIONS: Record<string, GeoLocation> = { '1.1.1.1': SYDNEY, '2001:db8::1': BERLIN };

const HOUR = 60 * 60 * 1000;

type Responder = (request: BatchLookupRequest) => Response | Promise<Response>;

function answer({ addresses }: BatchLookupRequest): Response {
  return Response.json({
    results: addresses.map((address) => {
      const location = LOCATIONS[address];
      if (location) return { address, status: 'found', location };
      if (address === 'not-an-address') return { address, status: 'invalid' };
      return { address, status: 'not-found' };
    }),
  });
}

class StubGeoIpService {
  readonly requests: BatchLookupRequest[] = [];
  respond: Responder = answer;
  readonly server = Bun.serve({
    port: 0,
    routes: {
      '/lookup': { POST: (request) => this.#receive(request) },
    },
  });

  async #receive(request: Request): Promise<Response> {
    const body = (await request.json()) as BatchLookupRequest;
    this.requests.push(body);
    return this.respond(body);
  }
}

let stub: StubGeoIpService;
let clock: number;

function client(options: Partial<GeoIpClientOptions> = {}) {
  return new GeoIpClient({ baseUrl: stub.server.url.href, now: () => clock, ...options });
}

beforeEach(() => {
  stub = new StubGeoIpService();
  clock = 0;
});

afterEach(async () => {
  await stub.server.stop(true);
});

describe('batching', () => {
  it('sends unique addresses in batches of the configured size and returns a result per address', async () => {
    const results = await client({ maxBatchSize: 2 }).lookupMany(['1.1.1.1', '2001:db8::1', '10.0.0.1', '1.1.1.1', 'not-an-address']);

    expect(stub.requests.map((request) => request.addresses)).toEqual([
      ['1.1.1.1', '2001:db8::1'],
      ['10.0.0.1', 'not-an-address'],
    ]);
    expect(Object.fromEntries(results)).toEqual({
      '1.1.1.1': { status: 'found', location: SYDNEY, stale: false },
      '2001:db8::1': { status: 'found', location: BERLIN, stale: false },
      '10.0.0.1': { status: 'not-found', stale: false },
      'not-an-address': { status: 'invalid', stale: false },
    });
  });

  it('asks for the H3 resolution it was configured with', async () => {
    await client({ h3Resolution: 4 }).lookup('1.1.1.1');

    expect(stub.requests).toEqual([{ addresses: ['1.1.1.1'], h3Resolution: 4 }]);
  });
});

describe('cache', () => {
  it('asks only for addresses it has no fresh entry for', async () => {
    const geo = client();

    await geo.lookupMany(['1.1.1.1', '10.0.0.1']);
    await geo.lookupMany(['1.1.1.1', '10.0.0.1', '2001:db8::1']);
    await geo.lookupMany(['1.1.1.1', '10.0.0.1', '2001:db8::1']);

    expect(stub.requests.map((request) => request.addresses)).toEqual([['1.1.1.1', '10.0.0.1'], ['2001:db8::1']]);
  });

  it('asks again once an entry is older than the cache TTL', async () => {
    const geo = client({ cacheTtlMs: HOUR });

    await geo.lookup('1.1.1.1');
    clock += HOUR - 1;
    await geo.lookup('1.1.1.1');
    clock += 1;
    await geo.lookup('1.1.1.1');

    expect(stub.requests).toHaveLength(2);
  });

  it('drops the oldest entries beyond the configured size', async () => {
    const geo = client({ maxCacheEntries: 2 });

    await geo.lookupMany(['1.1.1.1', '2001:db8::1', '10.0.0.1']);
    await geo.lookup('1.1.1.1');

    expect(geo.state().entries).toBe(2);
    expect(stub.requests.at(-1)?.addresses).toEqual(['1.1.1.1']);
  });
});

describe('when geo-ip-service fails', () => {
  const failures: [string, () => void | Promise<void>, string][] = [
    ['answers with an error status', () => void (stub.respond = () => new Response('', { status: 500 })), 'geo-ip-service answered 500'],
    ['answers without results', () => void (stub.respond = () => Response.json({})), 'geo-ip-service answered without results'],
    ['does not answer in time', () => void (stub.respond = () => Bun.sleep(200).then(() => answer({ addresses: [] }))), 'timed out'],
    ['is unreachable', () => stub.server.stop(true), ''],
  ];

  it.each(failures)('serves expired entries as stale when the service %s', async (_, fail, error) => {
    const geo = client({ cacheTtlMs: HOUR, requestTimeoutMs: 50 });
    await geo.lookupMany(['1.1.1.1', '10.0.0.1']);
    clock += 2 * HOUR;
    await fail();

    const results = await geo.lookupMany(['1.1.1.1', '10.0.0.1', '2001:db8::1']);

    expect(Object.fromEntries(results)).toEqual({
      '1.1.1.1': { status: 'found', location: SYDNEY, stale: true },
      '10.0.0.1': { status: 'not-found', stale: true },
      '2001:db8::1': { status: 'unavailable' },
    });
    expect(geo.state()).toMatchObject({ entries: 2, expiredEntries: 2, failing: true, lastFailureAt: new Date(2 * HOUR).toISOString() });
    expect(geo.state().lastError).toContain(error);
  });

  it('stops sending batches for the rest of a lookup after one fails', async () => {
    stub.respond = () => new Response('', { status: 503 });

    await client({ maxBatchSize: 1 }).lookupMany(['1.1.1.1', '2001:db8::1', '10.0.0.1']);

    expect(stub.requests).toHaveLength(1);
  });

  it('waits before asking again and recovers on the next success', async () => {
    const geo = client({ retryAfterFailureMs: 30_000 });
    stub.respond = () => new Response('', { status: 503 });
    await geo.lookup('1.1.1.1');

    clock += 29_999;
    expect(await geo.lookup('1.1.1.1')).toEqual({ status: 'unavailable' });
    expect(stub.requests).toHaveLength(1);

    stub.respond = answer;
    clock += 1;
    expect(await geo.lookup('1.1.1.1')).toEqual({ status: 'found', location: SYDNEY, stale: false });
    expect(stub.requests).toHaveLength(2);
    expect(geo.state()).toMatchObject({ failing: false, lastSuccessAt: new Date(30_000).toISOString() });
  });
});

describe('address', () => {
  it('resolves the address for every request when given a function', async () => {
    const other = new StubGeoIpService();
    let current = stub.server.url.href;
    const geo = client({ baseUrl: () => current, cacheTtlMs: HOUR });

    await geo.lookup('1.1.1.1');
    current = other.server.url.href;
    await geo.lookup('2001:db8::1');

    expect(stub.requests).toEqual([{ addresses: ['1.1.1.1'] }]);
    expect(other.requests).toEqual([{ addresses: ['2001:db8::1'] }]);
    await other.server.stop(true);
  });

  it('treats an unknown address as a failure without sending a request', async () => {
    const geo = client({ baseUrl: () => undefined });

    expect(await geo.lookup('1.1.1.1')).toEqual({ status: 'unavailable' });
    expect(stub.requests).toHaveLength(0);
    expect(geo.state()).toMatchObject({ failing: true, lastError: 'geo-ip-service address is not known' });
  });
});
