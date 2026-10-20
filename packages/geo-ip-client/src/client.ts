import { BATCH_LOOKUP_PATH, type BatchLookupItem, type BatchLookupRequest, type BatchLookupResponse, type LookupResult } from './protocol';

export type CachedLookup = LookupResult & { stale: boolean };

export type ClientLookup = CachedLookup | { status: 'unavailable' };

export interface GeoIpClientState {
  entries: number;
  expiredEntries: number;
  failing: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

export interface WarningLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type BaseUrl = string | (() => string | undefined);

export interface GeoIpClientOptions {
  baseUrl: BaseUrl;
  h3Resolution?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxBatchSize?: number;
  requestTimeoutMs?: number;
  retryAfterFailureMs?: number;
  logger?: WarningLogger;
  now?: () => number;
}

export const GEO_IP_CLIENT_DEFAULTS = {
  cacheTtlMs: 60 * 60 * 1000,
  maxCacheEntries: 50_000,
  maxBatchSize: 10_000,
  requestTimeoutMs: 5_000,
  retryAfterFailureMs: 30_000,
};

interface CacheEntry {
  result: LookupResult;
  fetchedAt: number;
}

function lookupUrlFrom(baseUrl: BaseUrl): () => URL {
  if (typeof baseUrl === 'string') {
    const url = new URL(BATCH_LOOKUP_PATH, baseUrl);
    return () => url;
  }
  return () => {
    const current = baseUrl();
    if (!current) throw new Error('geo-ip-service address is not known');
    return new URL(BATCH_LOOKUP_PATH, current);
  };
}

function isoOrNull(time: number | undefined): string | null {
  return time === undefined ? null : new Date(time).toISOString();
}

export class GeoIpClient {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #lookupUrl: () => URL;
  readonly #h3Resolution: number | undefined;
  readonly #settings: typeof GEO_IP_CLIENT_DEFAULTS;
  readonly #logger: WarningLogger | undefined;
  readonly #now: () => number;
  #failing = false;
  #lastSuccessAt: number | undefined;
  #lastFailureAt: number | undefined;
  #lastError: string | undefined;

  constructor(options: GeoIpClientOptions) {
    this.#lookupUrl = lookupUrlFrom(options.baseUrl);
    this.#h3Resolution = options.h3Resolution;
    this.#settings = {
      cacheTtlMs: options.cacheTtlMs ?? GEO_IP_CLIENT_DEFAULTS.cacheTtlMs,
      maxCacheEntries: options.maxCacheEntries ?? GEO_IP_CLIENT_DEFAULTS.maxCacheEntries,
      maxBatchSize: options.maxBatchSize ?? GEO_IP_CLIENT_DEFAULTS.maxBatchSize,
      requestTimeoutMs: options.requestTimeoutMs ?? GEO_IP_CLIENT_DEFAULTS.requestTimeoutMs,
      retryAfterFailureMs: options.retryAfterFailureMs ?? GEO_IP_CLIENT_DEFAULTS.retryAfterFailureMs,
    };
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  async lookup(address: string): Promise<ClientLookup> {
    return (await this.lookupMany([address])).get(address) ?? { status: 'unavailable' };
  }

  async lookupMany(addresses: Iterable<string>): Promise<Map<string, ClientLookup>> {
    const unique = [...new Set(addresses)];
    const due = unique.filter((address) => !this.#isFresh(this.#cache.get(address)));

    if (due.length > 0 && !this.#backingOff()) {
      await this.#fetch(due);
    }

    return new Map(unique.map((address) => [address, this.#cached(address)]));
  }

  state(): GeoIpClientState {
    const entries = [...this.#cache.values()];
    return {
      entries: entries.length,
      expiredEntries: entries.filter((entry) => !this.#isFresh(entry)).length,
      failing: this.#failing,
      lastSuccessAt: isoOrNull(this.#lastSuccessAt),
      lastFailureAt: isoOrNull(this.#lastFailureAt),
      lastError: this.#lastError ?? null,
    };
  }

  #isFresh(entry: CacheEntry | undefined): boolean {
    return entry !== undefined && this.#now() - entry.fetchedAt < this.#settings.cacheTtlMs;
  }

  #cached(address: string): ClientLookup {
    const entry = this.#cache.get(address);
    return entry ? { ...entry.result, stale: !this.#isFresh(entry) } : { status: 'unavailable' };
  }

  #backingOff(): boolean {
    return this.#failing && this.#lastFailureAt !== undefined && this.#now() - this.#lastFailureAt < this.#settings.retryAfterFailureMs;
  }

  async #fetch(addresses: string[]): Promise<void> {
    for (let start = 0; start < addresses.length; start += this.#settings.maxBatchSize) {
      const batch = addresses.slice(start, start + this.#settings.maxBatchSize);
      try {
        this.#store(await this.#request(batch));
        this.#failing = false;
        this.#lastSuccessAt = this.#now();
      } catch (error) {
        this.#failing = true;
        this.#lastFailureAt = this.#now();
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#logger?.warn('geo-ip-service lookup failed', { addresses: batch.length, error });
        return;
      }
    }
  }

  async #request(addresses: string[]): Promise<BatchLookupItem[]> {
    const request: BatchLookupRequest = { addresses, h3Resolution: this.#h3Resolution };
    const response = await fetch(this.#lookupUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.#settings.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`geo-ip-service answered ${response.status}`);
    }
    const { results } = (await response.json()) as Partial<BatchLookupResponse>;
    if (!Array.isArray(results)) {
      throw new Error('geo-ip-service answered without results');
    }
    return results;
  }

  #store(items: BatchLookupItem[]): void {
    const fetchedAt = this.#now();
    for (const { address, ...result } of items) {
      this.#cache.delete(address);
      this.#cache.set(address, { result, fetchedAt });
    }
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#settings.maxCacheEntries) break;
      this.#cache.delete(oldest);
    }
  }
}
