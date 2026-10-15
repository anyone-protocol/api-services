export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface H3Cell {
  resolution: number;
  cell: string;
  center: Coordinates;
}

export interface GeoLocation {
  coordinates?: Coordinates;
  countryCode?: string;
  countryName?: string;
  regionName?: string;
  cityName?: string;
  timeZone?: string;
  asNumber?: number;
  asName?: string;
  h3?: H3Cell;
}

export type LookupResult = { status: 'found'; location: GeoLocation } | { status: 'not-found' } | { status: 'invalid' };

export interface BatchLookupRequest {
  addresses: string[];
  h3Resolution?: number;
}

export type BatchLookupItem = LookupResult & { address: string };

export interface BatchLookupResponse {
  results: BatchLookupItem[];
}

export const BATCH_LOOKUP_PATH = '/lookup';
