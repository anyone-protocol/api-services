import { Secret } from '@anyone-protocol/service-kit';
import type { Edition } from './databases';

export const MAXMIND_DOWNLOAD_URL = 'https://download.maxmind.com/geoip/databases';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface MaxMindCredentials {
  accountId: string;
  licenseKey: Secret<string>;
}

export interface MaxMindDownloadsOptions {
  baseUrl?: string;
  credentials: MaxMindCredentials;
  timeoutMs?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

class DownloadFailed extends Error {}

export function maxMindCredentials(accountId: string | undefined, licenseKey: Secret<string> | undefined): MaxMindCredentials | undefined {
  if (accountId && licenseKey) return { accountId, licenseKey };
  if (accountId || licenseKey) {
    throw new Error('Invalid environment: MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY must be set together');
  }
  return undefined;
}

export class MaxMindDownloads {
  readonly #baseUrl: string;
  readonly #authorization: Secret<string>;
  readonly #timeoutMs: number;

  constructor({ baseUrl = MAXMIND_DOWNLOAD_URL, credentials, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS }: MaxMindDownloadsOptions) {
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.#authorization = new Secret(`Basic ${btoa(`${credentials.accountId}:${credentials.licenseKey.reveal()}`)}`);
    this.#timeoutMs = timeoutMs;
  }

  async checksum(edition: Edition): Promise<string> {
    const text = await (await this.#download(edition, 'tar.gz.sha256')).text();
    const checksum = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!SHA256.test(checksum)) {
      throw new Error(`MaxMind sent a checksum file for ${edition} without a SHA-256 checksum`);
    }
    return checksum;
  }

  async archive(edition: Edition): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await (await this.#download(edition, 'tar.gz')).arrayBuffer());
  }

  async #download(edition: Edition, suffix: string): Promise<Response> {
    try {
      return await this.#fetch(edition, suffix);
    } catch (error) {
      if (error instanceof DownloadFailed) throw error;
      throw new Error(`MaxMind request for ${edition} ${suffix} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #fetch(edition: Edition, suffix: string): Promise<Response> {
    const url = new URL(`${edition}/download`, this.#baseUrl);
    url.searchParams.set('suffix', suffix);
    const signal = AbortSignal.timeout(this.#timeoutMs);

    let response = await fetch(url, { headers: { authorization: this.#authorization.reveal() }, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      response = await fetch(new URL(location, url), { redirect: 'manual', signal });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
      throw new DownloadFailed(`MaxMind answered ${response.status} for ${edition} ${suffix}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  }
}
