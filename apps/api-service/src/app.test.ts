import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';

let server: Server;
let url: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('GET /healthz', () => {
  it('reports the service as ok', async () => {
    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'api-service', status: 'ok' });
  });
});
