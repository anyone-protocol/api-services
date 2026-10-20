import type { ClientLookup } from '@anyone-protocol/geo-ip-client';
import { describe, expect, it } from 'bun:test';
import { getResolution } from 'h3-js';
import type { Relay } from './onionoo';
import { fingerprintMap, GeolocationUnavailable, type Geolocator, relayMap } from './relay-maps';

const FOUND: ClientLookup = { status: 'found', location: { coordinates: { latitude: 58.4167, longitude: 15.6167 }, countryCode: 'SE' }, stale: true };

function geolocator(results: Record<string, ClientLookup>): Geolocator {
  return {
    lookupMany: async (addresses) => new Map([...addresses].map((address) => [address, results[address] ?? { status: 'unavailable' }])),
  };
}

function relay(fingerprint: string, ...or_addresses: string[]): Relay {
  return { fingerprint, or_addresses };
}

describe('relay maps', () => {
  it('leave out relays whose address has no result while others are served from the cache', async () => {
    const relays = [relay('A', '192.0.2.1:9001'), relay('B', '192.0.2.2:9001')];
    const geo = geolocator({ '192.0.2.1': FOUND });

    expect(await relayMap(relays, geo, 4)).toMatchObject([{ relayCount: 1 }]);
    expect(Object.keys(await fingerprintMap(relays, geo, 4))).toEqual(['A']);
  });

  it('throw when no address has a result', async () => {
    const relays = [relay('A', '192.0.2.1:9001')];

    await expect(relayMap(relays, geolocator({}), 4)).rejects.toBeInstanceOf(GeolocationUnavailable);
    await expect(fingerprintMap(relays, geolocator({}), 4)).rejects.toBeInstanceOf(GeolocationUnavailable);
  });

  it('answer empty maps when there are no relays', async () => {
    expect(await relayMap([], geolocator({}), 4)).toEqual([]);
    expect(await fingerprintMap([relay('A')], geolocator({}), 4)).toEqual({});
  });

  it('use the H3 resolution they are given', async () => {
    const [cell] = await relayMap([relay('A', '192.0.2.1:9001')], geolocator({ '192.0.2.1': FOUND }), 7);

    expect(getResolution(cell?.index ?? '')).toBe(7);
  });
});
