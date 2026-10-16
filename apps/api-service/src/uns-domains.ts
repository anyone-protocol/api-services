import type { Logger } from '@anyone-protocol/service-kit';
import type { SQL } from 'bun';

export interface UnsTokenRow {
  tokenId: string;
  name: string;
  owner: string;
}

export interface AnyoneDomain extends UnsTokenRow {
  tld: 'anyone';
}

export type UnsTokenRows = () => Promise<UnsTokenRow[]>;

export function unsTokenRows(sql: SQL): UnsTokenRows {
  return () => sql`SELECT "tokenId", "name", "owner" FROM uns_tokens`;
}

export interface UnsDomainsOptions {
  rows: UnsTokenRows;
  cacheTtlMs: number;
  logger: Logger;
  now?: () => number;
}

export class UnsDomains {
  readonly #options: UnsDomainsOptions;
  readonly #now: () => number;
  #cached: AnyoneDomain[] | undefined;
  #cachedAt = 0;

  constructor(options: UnsDomainsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async anyoneDomains(): Promise<AnyoneDomain[]> {
    const now = this.#now();
    if (this.#cached && now - this.#cachedAt < this.#options.cacheTtlMs) {
      return this.#cached;
    }

    try {
      const rows = await this.#options.rows();
      this.#cached = rows.map(({ tokenId, name, owner }) => ({ tokenId, name, owner, tld: 'anyone' }));
      this.#cachedAt = now;
      return this.#cached;
    } catch (error) {
      this.#options.logger.error('Failed to read anyone domains from the UNS indexer database', { error, stale: this.#cached !== undefined });
      return this.#cached ?? [];
    }
  }
}
