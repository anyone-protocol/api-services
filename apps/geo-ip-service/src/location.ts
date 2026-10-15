import type { Coordinates, GeoLocation, H3Cell } from '@anyone-protocol/geo-ip-client';
import { cellToLatLng, latLngToCell } from 'h3-js';
import type { AsnResponse, CityResponse } from 'maxmind';

export const MAX_H3_RESOLUTION = 15;

export function isH3Resolution(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_H3_RESOLUTION;
}

function coordinatesOf(location: CityResponse['location']): Coordinates | undefined {
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  return typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : undefined;
}

function h3CellOf({ latitude, longitude }: Coordinates, resolution: number): H3Cell {
  const cell = latLngToCell(latitude, longitude, resolution);
  const [centerLatitude, centerLongitude] = cellToLatLng(cell);
  return { resolution, cell, center: { latitude: centerLatitude, longitude: centerLongitude } };
}

export function toLocation(city: CityResponse | null, asn: AsnResponse | null, h3Resolution?: number): GeoLocation {
  const coordinates = coordinatesOf(city?.location);
  const location: GeoLocation = {
    coordinates,
    countryCode: city?.country?.iso_code,
    countryName: city?.country?.names.en,
    regionName: city?.subdivisions?.[0]?.names.en,
    cityName: city?.city?.names.en,
    timeZone: city?.location?.time_zone,
    asNumber: asn?.autonomous_system_number,
    asName: asn?.autonomous_system_organization,
    h3: coordinates && h3Resolution !== undefined ? h3CellOf(coordinates, h3Resolution) : undefined,
  };
  return Object.fromEntries(Object.entries(location).filter(([, value]) => value !== undefined));
}
