import type { Secret } from '@anyone-protocol/service-kit';
import type { Edition } from './databases';

export const MAXMIND_DOWNLOAD_URL = 'https://download.maxmind.com/app/geoip_download';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface MaxMindDownloadsOptions {
  baseUrl?: string;
  licenseKey: Secret<string>;
  timeoutMs?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

export class MaxMindDownloads {
  readonly #baseUrl: string;
  readonly #licenseKey: Secret<string>;
  readonly #timeoutMs: number;

  constructor({ baseUrl = MAXMIND_DOWNLOAD_URL, licenseKey, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS }: MaxMindDownloadsOptions) {
    this.#baseUrl = baseUrl;
    this.#licenseKey = licenseKey;
    this.#timeoutMs = timeoutMs;
  }

  async release(edition: Edition): Promise<string | null> {
    const response = await this.#request('HEAD', edition, 'tar.gz');
    return response.headers.get('last-modified') ?? response.headers.get('content-disposition');
  }

  async checksum(edition: Edition): Promise<string> {
    const text = await (await this.#request('GET', edition, 'tar.gz.sha256')).text();
    const checksum = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!SHA256.test(checksum)) {
      throw new Error(`MaxMind sent a checksum file for ${edition} without a SHA-256 checksum`);
    }
    return checksum;
  }

  async archive(edition: Edition): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await (await this.#request('GET', edition, 'tar.gz')).arrayBuffer());
  }

  async #request(method: 'GET' | 'HEAD', edition: Edition, suffix: string): Promise<Response> {
    const url = new URL(this.#baseUrl);
    url.searchParams.set('edition_id', edition);
    url.searchParams.set('license_key', this.#licenseKey.reveal());
    url.searchParams.set('suffix', suffix);

    let response: Response;
    try {
      response = await fetch(url, { method, redirect: method === 'HEAD' ? 'manual' : 'follow', signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      throw new Error(`MaxMind ${method} for ${edition} ${suffix} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 400 || (method === 'GET' && !response.ok)) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
      throw new Error(`MaxMind answered ${response.status} to ${method} for ${edition} ${suffix}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  }
}
