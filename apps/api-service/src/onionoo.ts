export const DETAILS_FIELDS = ['fingerprint', 'nickname', 'running', 'consensus_weight', 'observed_bandwidth', 'measured', 'or_addresses'].join(',');

export interface Relay {
  fingerprint: string;
  nickname?: string;
  running?: boolean;
  consensus_weight?: number;
  observed_bandwidth?: number;
  measured?: boolean;
  or_addresses: string[];
}

export interface DetailsDocument {
  relays: Relay[];
}

export interface OnionooOptions {
  baseUrl: string;
  cacheTtlMs: number;
  timeoutMs: number;
  now?: () => number;
}

export class Onionoo {
  readonly #baseUrl: string;
  readonly #cacheTtlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #cached: DetailsDocument | undefined;
  #cachedAt = 0;
  #pending: Promise<DetailsDocument> | undefined;

  constructor({ baseUrl, cacheTtlMs, timeoutMs, now = Date.now }: OnionooOptions) {
    this.#baseUrl = baseUrl;
    this.#cacheTtlMs = cacheTtlMs;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  details(): Promise<DetailsDocument> {
    if (this.#cached && this.#now() - this.#cachedAt < this.#cacheTtlMs) {
      return Promise.resolve(this.#cached);
    }
    this.#pending ??= this.#fetchDetails().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async updateHardwareInfo(hardwareInfo: { fingerprint: string }): Promise<string> {
    const response = await fetch(`${this.#baseUrl}/hardware/${encodeURIComponent(hardwareInfo.fingerprint)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hardwareInfo),
    });
    if (!response.ok) throw new Error(`Onionoo answered ${response.status} to a hardware update`);
    return response.text();
  }

  async #fetchDetails(): Promise<DetailsDocument> {
    const response = await fetch(`${this.#baseUrl}/details?fields=${DETAILS_FIELDS}`, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!response.ok) throw new Error(`Onionoo answered ${response.status} to a details request`);
    const details = (await response.json()) as DetailsDocument;
    this.#cached = details;
    this.#cachedAt = this.#now();
    return details;
  }
}
