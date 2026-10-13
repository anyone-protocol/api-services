import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startServer } from './app';

let server: ReturnType<typeof startServer>;

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  await server.stop();
});

describe('GET /healthz', () => {
  it('reports the service as ok', async () => {
    const response = await fetch(new URL('/healthz', server.url));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'api-service', status: 'ok' });
  });
});

describe('an unknown path', () => {
  it('is not found', async () => {
    const response = await fetch(new URL('/missing', server.url));

    expect(response.status).toBe(404);
  });
});
