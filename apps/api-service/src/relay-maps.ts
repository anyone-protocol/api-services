import type { ClientLookup, GeoLocation } from '@anyone-protocol/geo-ip-client';
import { cellToBoundary, cellToLatLng, latLngToCell } from 'h3-js';
import type { Relay } from './onionoo';

export interface Geolocator {
  lookupMany(addresses: Iterable<string>): Promise<Map<string, ClientLookup>>;
}

export class GeolocationUnavailable extends Error {
  constructor() {
    super('geo-ip-service is unavailable and no address has a cached result');
  }
}

export interface HexInfo {
  index: string;
  relayCount: number;
  geo: number[];
  boundary: number[][];
}

export interface RelayLocation {
  hexId: string;
  coordinates: number[];
  countryCode?: string;
  countryName?: string;
  regionName?: string;
  cityName?: string;
  asNumber?: string;
  asName?: string;
}

interface Placed {
  location: GeoLocation;
  latitude: number;
  longitude: number;
}

function primaryAddress(relay: Relay): string | undefined {
  return relay.or_addresses[0]?.split(':')[0];
}

async function locate(geo: Geolocator, addresses: string[]): Promise<Map<string, ClientLookup>> {
  const results = await geo.lookupMany(addresses);
  if (results.size > 0 && [...results.values()].every((result) => result.status === 'unavailable')) {
    throw new GeolocationUnavailable();
  }
  return results;
}

function place(result: ClientLookup | undefined): Placed | undefined {
  if (result?.status !== 'found') return undefined;
  const { latitude, longitude } = result.location.coordinates ?? {};
  return latitude && longitude ? { location: result.location, latitude, longitude } : undefined;
}

export async function relayMap(relays: Relay[], geo: Geolocator, resolution: number): Promise<HexInfo[]> {
  const addresses = relays.map((relay) => primaryAddress(relay)).filter((address) => address !== undefined);
  const located = await locate(geo, addresses);

  const relayCounts = new Map<string, number>();
  for (const address of addresses) {
    const placed = place(located.get(address));
    if (!placed) continue;
    const cell = latLngToCell(placed.latitude, placed.longitude, resolution);
    relayCounts.set(cell, (relayCounts.get(cell) ?? 0) + 1);
  }

  return [...relayCounts].map(([index, relayCount]) => ({ index, relayCount, geo: cellToLatLng(index), boundary: cellToBoundary(index) }));
}

export async function fingerprintMap(relays: Relay[], geo: Geolocator, resolution: number): Promise<Record<string, RelayLocation>> {
  const addressed = relays.flatMap((relay) => {
    const address = relay.or_addresses?.length ? primaryAddress(relay) : undefined;
    return address ? [{ relay, address }] : [];
  });
  const located = await locate(geo, addressed.map(({ address }) => address));

  const result: Record<string, RelayLocation> = {};
  for (const { relay, address } of addressed) {
    const placed = place(located.get(address));
    if (!placed) continue;
    const hexId = latLngToCell(placed.latitude, placed.longitude, resolution);
    const { countryCode, countryName, regionName, cityName, asNumber, asName } = placed.location;
    result[relay.fingerprint] = { hexId, coordinates: cellToLatLng(hexId), countryCode, countryName, regionName, cityName, asNumber: asNumber?.toString(), asName };
  }
  return result;
}
