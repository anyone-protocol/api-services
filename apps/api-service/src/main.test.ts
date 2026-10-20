import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import packageJson from '../package.json';
import { StubUpstreams } from './testing/stubs';

const [, ...START_ARGUMENTS] = packageJson.scripts.start.split(' ');
const OLD_SERVICE_MAX_HEADER_BYTES = 80_000;

let upstreams: StubUpstreams;
let service: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'inherit'>>;

async function listeningPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  let output = '';
  for await (const chunk of stdout) {
    output += decoder.decode(chunk, { stream: true });
    for (const line of output.split('\n')) {
      if (line.includes('"Listening"')) return (JSON.parse(line) as { port: number }).port;
    }
  }
  throw new Error(`api-service exited before listening: ${output}`);
}

function relaysQuery(bytes: number): string {
  const fingerprint = 'A'.repeat(40);
  return `/relays?fingerprints=${Array.from({ length: Math.ceil(bytes / 41) }, () => fingerprint).join(',')}`.slice(0, bytes);
}

beforeEach(() => {
  upstreams = new StubUpstreams();
  service = Bun.spawn([process.execPath, ...START_ARGUMENTS], {
    cwd: join(import.meta.dir, '..'),
    env: {
      PORT: '0',
      ONIONOO_INSTANCE: upstreams.address,
      VICTORIA_METRICS_ADDRESS: upstreams.url,
      GEO_IP_SERVICE_URL: upstreams.url,
      HB_URL: upstreams.url,
      OPERATOR_REGISTRY_PROCESS_ID: 'operator-registry-process-id',
      DB_HOST: '127.0.0.1',
      DB_USER: 'api',
      DB_NAME: 'uns_indexer',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
});

afterEach(async () => {
  service.kill('SIGKILL');
  await upstreams.server.stop(true);
});

describe('the start command', () => {
  it('accepts a relay request as long as the old service allowed and stops cleanly on SIGTERM', async () => {
    const base = `http://127.0.0.1:${await listeningPort(service.stdout)}`;

    const longest = await fetch(base + relaysQuery(OLD_SERVICE_MAX_HEADER_BYTES - 1_000));
    const tooLong = await fetch(base + relaysQuery(OLD_SERVICE_MAX_HEADER_BYTES + 1_000));
    service.kill('SIGTERM');

    expect(longest.status).toBe(200);
    expect(tooLong.status).toBe(431);
    expect(await service.exited).toBe(0);
  }, 20_000);
});
