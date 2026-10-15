import type { LookupResult } from '@anyone-protocol/geo-ip-client';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Reader, type AsnResponse, type CityResponse, type Response } from 'maxmind';
import { toLocation } from './location';

export const CITY = 'GeoLite2-City';
export const ASN = 'GeoLite2-ASN';
export const EDITIONS = [CITY, ASN] as const;

export type Edition = (typeof EDITIONS)[number];

export interface DatabaseState {
  edition: Edition;
  loaded: boolean;
  buildDate: string | null;
  loadedAt: string | null;
  lastError: string | null;
}

interface LoadedDatabase {
  reader: Reader<Response>;
  buildDate: Date;
  loadedAt: Date;
}

export function databasePath(directory: string, edition: Edition): string {
  return join(directory, `${edition}.mmdb`);
}

export class GeoDatabases {
  readonly #loaded = new Map<Edition, LoadedDatabase>();
  readonly #errors = new Map<Edition, string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get ready(): boolean {
    return this.#loaded.has(CITY);
  }

  async load(edition: Edition, path: string): Promise<DatabaseState> {
    try {
      const reader = new Reader<Response>(await readFile(path));
      if (reader.metadata.databaseType !== edition) {
        throw new Error(`${path} holds ${reader.metadata.databaseType}, expected ${edition}`);
      }
      this.#loaded.set(edition, { reader, buildDate: reader.metadata.buildEpoch, loadedAt: new Date(this.#now()) });
      this.#errors.delete(edition);
    } catch (error) {
      this.#errors.set(edition, error instanceof Error ? error.message : String(error));
    }
    return this.state(edition);
  }

  state(edition: Edition): DatabaseState {
    const database = this.#loaded.get(edition);
    return {
      edition,
      loaded: database !== undefined,
      buildDate: database?.buildDate.toISOString() ?? null,
      loadedAt: database?.loadedAt.toISOString() ?? null,
      lastError: this.#errors.get(edition) ?? null,
    };
  }

  lookup(address: string, h3Resolution?: number): LookupResult {
    if (isIP(address) === 0) {
      return { status: 'invalid' };
    }
    const city = (this.#loaded.get(CITY)?.reader.get(address) ?? null) as CityResponse | null;
    const asn = (this.#loaded.get(ASN)?.reader.get(address) ?? null) as AsnResponse | null;
    if (!city && !asn) {
      return { status: 'not-found' };
    }
    return { status: 'found', location: toLocation(city, asn, h3Resolution) };
  }
}
