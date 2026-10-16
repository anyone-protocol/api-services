import { createLogger } from '@anyone-protocol/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { OperatorRegistry, type OperatorRegistryOptions } from './operator-registry';
import { StubUpstreams } from './testing/stubs';

const PROCESS_ID = 'operator-registry-process-id';
const VIEW_PATH = `/${PROCESS_ID}~process@1.0/as/operators`;
const OPERATORS = { '0xAbC0000000000000000000000000000000000001': true, '0x0000000000000000000000000000000000000002': true };

let upstreams: StubUpstreams;
let clock: number;

function registry(options: Partial<OperatorRegistryOptions> = {}) {
  return new OperatorRegistry({
    nodeUrl: `${upstreams.url}/`,
    processId: PROCESS_ID,
    cacheTtlMs: 0,
    logger: createLogger({ service: 'api-service', write: () => {} }),
    read: { retryDelayMs: 1 },
    now: () => clock,
    ...options,
  });
}

beforeEach(() => {
  upstreams = new StubUpstreams();
  upstreams.operators = OPERATORS;
  clock = 0;
});

afterEach(async () => {
  await upstreams.server.stop(true);
});

describe('OperatorRegistry', () => {
  it('answers the addresses keyed in the operators view', async () => {
    expect(await registry().operators()).toEqual(Object.keys(OPERATORS));
    expect(upstreams.requests).toMatchObject([{ method: 'GET', path: VIEW_PATH }]);
  });

  it('answers an empty list for an empty registry, which the view returns as an array', async () => {
    upstreams.operators = [];

    expect(await registry().operators()).toEqual([]);
  });

  it('serves from cache within the TTL rather than reading again', async () => {
    const service = registry({ cacheTtlMs: 600_000 });

    const first = await service.operators();
    clock += 599_999;
    const second = await service.operators();

    expect(second).toEqual(first);
    expect(upstreams.requestsTo(VIEW_PATH)).toHaveLength(1);
  });

  it('keeps serving the last good list when the node fails', async () => {
    const service = registry();
    const good = await service.operators();

    upstreams.failWith = 502;

    expect(await service.operators()).toEqual(good);
  });

  it('answers an empty list when the node fails before anything was read', async () => {
    upstreams.failWith = 404;

    expect(await registry().operators()).toEqual([]);
  });

  it('retries a server error and not a client error', async () => {
    upstreams.failWith = 503;
    await registry().operators();
    expect(upstreams.requestsTo(VIEW_PATH)).toHaveLength(3);

    upstreams.requests.length = 0;
    upstreams.failWith = 404;
    await registry().operators();
    expect(upstreams.requestsTo(VIEW_PATH)).toHaveLength(1);
  });
});

const NODE_URL = process.env.HB_URL;
const NODE_PROCESS_ID = process.env.OPERATOR_REGISTRY_PROCESS_ID ?? '';
const HAVE_NODE = NODE_URL !== undefined && /^[A-Za-z0-9_-]{43}$/.test(NODE_PROCESS_ID);

describe.skipIf(!HAVE_NODE)('OperatorRegistry on a real node', () => {
  it(
    'reads unique operator addresses in mixed case',
    async () => {
      const service = new OperatorRegistry({ nodeUrl: NODE_URL ?? '', processId: NODE_PROCESS_ID, cacheTtlMs: 0, logger: createLogger({ service: 'api-service', write: () => {} }) });

      const operators = await service.operators();

      expect(operators.length).toBeGreaterThan(0);
      expect(new Set(operators).size).toBe(operators.length);
      for (const address of operators) {
        expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(address.slice(2)).not.toBe(address.slice(2).toUpperCase());
      }
    },
    60_000,
  );
});
