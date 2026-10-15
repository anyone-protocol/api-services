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
  loadedAt: Date;
}

export function databasePath(directory: string, edition: Edition): string {
  return join(directory, `${edition}.mmdb`);
}

export function openDatabase(edition: Edition, bytes: Buffer): Reader<Response> {
  const reader = new Reader<Response>(bytes);
  if (reader.metadata.databaseType !== edition) {
    throw new Error(`database holds ${reader.metadata.databaseType}, expected ${edition}`);
  }
  return reader;
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
      this.replace(edition, openDatabase(edition, await readFile(path)));
    } catch (error) {
      this.#errors.set(edition, `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.state(edition);
  }

  async loadAll(directory: string): Promise<DatabaseState[]> {
    const states: DatabaseState[] = [];
    for (const edition of EDITIONS) {
      states.push(await this.load(edition, databasePath(directory, edition)));
    }
    return states;
  }

  replace(edition: Edition, reader: Reader<Response>): void {
    this.#loaded.set(edition, { reader, loadedAt: new Date(this.#now()) });
    this.#errors.delete(edition);
  }

  buildDate(edition: Edition): Date | undefined {
    return this.#loaded.get(edition)?.reader.metadata.buildEpoch;
  }

  state(edition: Edition): DatabaseState {
    const database = this.#loaded.get(edition);
    return {
      edition,
      loaded: database !== undefined,
      buildDate: database?.reader.metadata.buildEpoch.toISOString() ?? null,
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
