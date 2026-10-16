import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DETAILS_FIELDS, Onionoo, type OnionooOptions } from './onionoo';
import { StubUpstreams } from './testing/stubs';

const DETAILS = { relays: [{ fingerprint: 'A'.repeat(40), or_addresses: ['192.0.2.1:9001'] }] };

let upstreams: StubUpstreams;
let clock: number;

function onionoo(options: Partial<OnionooOptions> = {}) {
  return new Onionoo({ baseUrl: upstreams.url, cacheTtlMs: 60_000, timeoutMs: 1_000, now: () => clock, ...options });
}

beforeEach(() => {
  upstreams = new StubUpstreams();
  upstreams.details = DETAILS;
  clock = 0;
});

afterEach(async () => {
  await upstreams.server.stop(true);
});

describe('details', () => {
  it('requests only the fields the service reads', async () => {
    expect(await onionoo().details()).toEqual(DETAILS);

    expect(upstreams.requestsTo('/details')).toMatchObject([{ params: { fields: DETAILS_FIELDS } }]);
    expect(DETAILS_FIELDS).toBe('fingerprint,nickname,running,consensus_weight,observed_bandwidth,measured,or_addresses');
  });

  it('shares one request between concurrent callers', async () => {
    const service = onionoo();

    const results = await Promise.all([service.details(), service.details(), service.details()]);

    expect(upstreams.requestsTo('/details')).toHaveLength(1);
    expect(results).toEqual([DETAILS, DETAILS, DETAILS]);
  });

  it('serves from cache until the TTL expires', async () => {
    const service = onionoo();

    await service.details();
    clock += 59_000;
    await service.details();
    expect(upstreams.requestsTo('/details')).toHaveLength(1);

    clock += 2_000;
    await service.details();
    expect(upstreams.requestsTo('/details')).toHaveLength(2);
  });

  it('does not cache a failed request', async () => {
    const service = onionoo();
    upstreams.failWith = 503;
    await expect(service.details()).rejects.toThrow('Onionoo answered 503');

    upstreams.failWith = undefined;
    expect(await service.details()).toEqual(DETAILS);
    expect(upstreams.requestsTo('/details')).toHaveLength(2);
  });

  it('asks every time when the TTL is zero', async () => {
    const service = onionoo({ cacheTtlMs: 0 });

    await service.details();
    await service.details();

    expect(upstreams.requestsTo('/details')).toHaveLength(2);
  });

  it('gives up after the timeout', async () => {
    const slow = Bun.serve({ port: 0, fetch: () => Bun.sleep(500).then(() => Response.json(DETAILS)) });

    await expect(onionoo({ baseUrl: slow.url.origin, timeoutMs: 50 }).details()).rejects.toThrow();
    await slow.stop(true);
  });
});

describe('updateHardwareInfo', () => {
  it('puts the hardware info as JSON under its fingerprint and returns the answer', async () => {
    const info = { fingerprint: 'A'.repeat(40), id: 'id' };

    expect(await onionoo().updateHardwareInfo(info)).toBe(upstreams.hardwareAnswer);
    expect(upstreams.requests).toEqual([{ method: 'PUT', path: `/hardware/${'A'.repeat(40)}`, params: {}, body: JSON.stringify(info) }]);
  });

  it('throws when Onionoo answers with an error', async () => {
    upstreams.failWith = 500;

    await expect(onionoo().updateHardwareInfo({ fingerprint: 'A'.repeat(40) })).rejects.toThrow('Onionoo answered 500');
  });
});
