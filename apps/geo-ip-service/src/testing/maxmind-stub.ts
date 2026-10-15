import { join } from 'node:path';
import { ASN, CITY, type Edition } from '../databases';

export const STUB_LICENSE_KEY = 'stub-license-key';
export const STUB_DOWNLOAD_PATH = '/app/geoip_download';

export const TEST_DATABASE_FILES: Record<Edition, string> = {
  [CITY]: join(import.meta.dir, '..', '..', 'test-data', 'GeoLite2-City-Test.mmdb'),
  [ASN]: join(import.meta.dir, '..', '..', 'test-data', 'GeoLite2-ASN-Test.mmdb'),
};

const BLOCK_SIZE = 512;
const encoder = new TextEncoder();

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
  put(path, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124);
  put('00000000000\0', 136);
  put('        ', 148);
  put('0', 156);
  put('ustar\0', 257);
  put('00', 263);
  put(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

export function makeArchive(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, data] of Object.entries(files)) {
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE);
    padded.set(data);
    blocks.push(tarHeader(path, data.length), padded);
  }
  blocks.push(new Uint8Array(2 * BLOCK_SIZE));
  return Bun.gzipSync(Buffer.concat(blocks));
}

export function editionArchive(edition: Edition, database: Uint8Array, release = '20261014'): Uint8Array {
  return makeArchive({
    [`${edition}_${release}/COPYRIGHT.txt`]: encoder.encode('Database and contents Copyright (c) MaxMind, Inc.\n'),
    [`${edition}_${release}/${edition}.mmdb`]: database,
  });
}

export interface StubRequest {
  method: string;
  path: string;
  edition: string | null;
  suffix: string | null;
  licenseKey: string | null;
}

export type StubOverride = (request: Request, url: URL) => Response | undefined;

interface Release {
  archive: Uint8Array;
  lastModified: string;
}

export async function startMaxMindStub({ port = 0 }: { port?: number } = {}) {
  const releases = new Map<Edition, Release>();
  let published = 0;
  const publish = (edition: Edition, archive: Uint8Array) => {
    releases.set(edition, { archive, lastModified: new Date(Date.UTC(2026, 9, 14) + 1000 * published++).toUTCString() });
  };
  for (const edition of [CITY, ASN] as const) {
    publish(edition, editionArchive(edition, await Bun.file(TEST_DATABASE_FILES[edition]).bytes()));
  }
  const requests: StubRequest[] = [];
  const control: { override: StubOverride | undefined } = { override: undefined };

  const answer = (url: URL): Response => {
    const file = /^\/files\/(GeoLite2-City|GeoLite2-ASN)\.tar\.gz$/.exec(url.pathname);
    if (file) {
      const release = releases.get(file[1] as Edition);
      return release ? new Response(release.archive) : new Response('Not Found', { status: 404 });
    }

    const edition = url.searchParams.get('edition_id') as Edition;
    const release = releases.get(edition);
    if (url.pathname !== STUB_DOWNLOAD_PATH || !release) return new Response('Not Found', { status: 404 });
    if (url.searchParams.get('license_key') !== STUB_LICENSE_KEY) return new Response('Invalid license key', { status: 401 });

    const suffix = url.searchParams.get('suffix');
    if (suffix === 'tar.gz.sha256') {
      const checksum = new Bun.CryptoHasher('sha256').update(release.archive).digest('hex');
      return new Response(`${checksum}  ${edition}_20261014.tar.gz\n`);
    }
    if (suffix === 'tar.gz') {
      return new Response(null, {
        status: 302,
        headers: {
          location: `/files/${edition}.tar.gz`,
          'last-modified': release.lastModified,
          'content-disposition': `attachment; filename=${edition}_20261014.tar.gz`,
        },
      });
    }
    return new Response('Invalid suffix', { status: 400 });
  };

  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        edition: url.searchParams.get('edition_id'),
        suffix: url.searchParams.get('suffix'),
        licenseKey: url.searchParams.get('license_key'),
      });
      return control.override?.(request, url) ?? answer(url);
    },
  });

  return {
    server,
    requests,
    downloadUrl: new URL(STUB_DOWNLOAD_PATH, server.url).href,
    publish,
    override(handler: StubOverride | undefined) {
      control.override = handler;
    },
  };
}

export type MaxMindStub = Awaited<ReturnType<typeof startMaxMindStub>>;

if (import.meta.main) {
  const stub = await startMaxMindStub({ port: Number(process.env.PORT ?? 4000) });
  console.log(`MaxMind stub serving the test databases at ${stub.downloadUrl}`);
  console.log(`MAXMIND_DOWNLOAD_URL=${stub.downloadUrl} MAXMIND_LICENSE_KEY=${STUB_LICENSE_KEY}`);
}
