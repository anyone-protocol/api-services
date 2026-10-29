import { createLogger } from '@anyone-protocol/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Tag } from './ans104';
import { createFetchHandler } from './app';
import { HyperbeamNode } from './node';
import { ProcessIds } from './processes';
import { RateLimiter } from './rate-limit';
import { ReadHandler } from './reads';
import { MessageStore } from './store';
import { randomSigner, signItem, type TestSigner, testSigner } from './testing/signing';
import { StubNode } from './testing/stub-node';
import { RolesCache, WriteHandler } from './writes';

const OPERATOR_REGISTRY = Buffer.alloc(32, 1).toString('base64url');
const RELAY_REWARDS = Buffer.alloc(32, 2).toString('base64url');
const STAKING_REWARDS = Buffer.alloc(32, 3).toString('base64url');
const FINGERPRINT = 'A'.repeat(40);
const OTHER_FINGERPRINT = 'B'.repeat(40);
const BASE_TAGS: Tag[] = [
  { name: 'type', value: 'Message' },
  { name: 'data-protocol', value: 'ao' },
  { name: 'variant', value: 'ao.N.1' },
  { name: 'require-codec', value: 'application/json' },
];

const logger = createLogger({ service: 'test', level: 'error', write: () => {} });
const operator = testSigner();
const stranger = randomSigner();

let node: StubNode;
let store: MessageStore;

interface BuildOptions {
  adminActions?: string[];
  adminSigners?: string[];
  perMinute?: number;
}

function gateway({ adminActions = [], adminSigners = [], perMinute = 100 }: BuildOptions = {}) {
  const hb = new HyperbeamNode({ url: node.url, readTimeoutMs: 5_000, writeTimeoutMs: 5_000 });
  const processes = new ProcessIds({ 'operator-registry': OPERATOR_REGISTRY, 'relay-rewards': RELAY_REWARDS, 'staking-rewards': STAKING_REWARDS });
  return createFetchHandler({
    maxBodyBytes: 64 * 1024,
    processes,
    reads: new ReadHandler({ node: hb, store, cacheTtlMs: 60_000 }),
    writes: new WriteHandler({
      processes,
      node: hb,
      store,
      admin: { actions: new Set(adminActions), signers: new Set(adminSigners) },
      limiter: new RateLimiter({ perMinute }),
      roles: new RolesCache(hb, 60_000),
      logger,
    }),
    logger,
  });
}

function message(signer: TestSigner, target: string, action: string, tags: Tag[] = [], data = ''): Uint8Array {
  return signItem(signer, { tags: [...BASE_TAGS, { name: 'action', value: action }, ...tags], data, target });
}

function push(handler: (request: Request) => Promise<Response>, processId: string, body: Uint8Array, headers: Record<string, string> = {}) {
  return handler(
    new Request(`http://gateway/${processId}~process@1.0/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/ans104', 'codec-device': 'ans104@1.0', ...headers },
      body,
    }),
  );
}

function get(handler: (request: Request) => Promise<Response>, path: string) {
  return handler(new Request(`http://gateway${path}`));
}

async function refusal(response: Response): Promise<[number, string]> {
  return [response.status, ((await response.json()) as { error: string }).error];
}

beforeEach(() => {
  node = new StubNode().start();
  store = new MessageStore(':memory:');
  node.operators.set(operator.address, { claimable: { [FINGERPRINT]: true }, verified: { [OTHER_FINGERPRINT]: true } });
});

afterEach(() => {
  node.stop();
  store.close();
});

describe('operator writes', () => {
  it('forwards a certificate submission for a claimable fingerprint unchanged', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', [
      { name: 'fingerprint-certificate', value: FINGERPRINT },
      { name: 'ui-cache-key', value: 'claim-1761600000000' },
    ]);
    const response = await push(gateway(), OPERATOR_REGISTRY, body);

    expect(response.status).toBe(200);
    expect(response.headers.get('slot')).toBe('1');
    expect(await response.json()).toEqual({ slot: 1 });
    const [forwarded] = node.pushes();
    expect(forwarded?.path).toBe(`/${OPERATOR_REGISTRY}~process@1.0/push`);
    expect(Buffer.from(forwarded?.body ?? []).equals(Buffer.from(body))).toBe(true);
    expect(forwarded?.headers['content-type']).toBe('application/ans104');
    expect(forwarded?.headers['codec-device']).toBe('ans104@1.0');
  });

  it('refuses a certificate submission the signer cannot claim without reaching the process', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', [{ name: 'fingerprint-certificate', value: OTHER_FINGERPRINT }]);
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([403, 'fingerprint is not claimable by the signer']);
    expect(node.pushes()).toHaveLength(0);
  });

  it('forwards a renounce only for a fingerprint verified to the signer', async () => {
    const handler = gateway();
    const verified = message(operator, OPERATOR_REGISTRY, 'Renounce-Fingerprint-Certificate', [{ name: 'fingerprint', value: OTHER_FINGERPRINT }]);
    const unverified = message(operator, OPERATOR_REGISTRY, 'Renounce-Fingerprint-Certificate', [{ name: 'fingerprint', value: FINGERPRINT }]);
    expect((await push(handler, OPERATOR_REGISTRY, verified)).status).toBe(200);
    expect(await refusal(await push(handler, OPERATOR_REGISTRY, unverified))).toEqual([403, 'fingerprint is not verified to the signer']);
  });

  it('forwards a delegate change from an operator and refuses one from anyone else', async () => {
    const handler = gateway();
    const tags = [
      { name: 'address', value: stranger.address },
      { name: 'share', value: '0.25' },
    ];
    expect((await push(handler, RELAY_REWARDS, message(operator, RELAY_REWARDS, 'Set-Delegate', tags))).status).toBe(200);
    expect(await refusal(await push(handler, RELAY_REWARDS, message(stranger, RELAY_REWARDS, 'Set-Delegate', tags)))).toEqual([403, 'signer is not a registered operator']);
  });

  it('checks the operator against operator-registry for writes to the reward processes', async () => {
    await push(gateway(), STAKING_REWARDS, message(operator, STAKING_REWARDS, 'Set-Share', [], '{"Share":0.1}'));
    expect(node.requests.map((request) => request.path)).toEqual([`/${OPERATOR_REGISTRY}~process@1.0/as/operator?address=${operator.address}`, `/${STAKING_REWARDS}~process@1.0/push`]);
  });

  it('refuses a share that is not a number', async () => {
    expect(await refusal(await push(gateway(), STAKING_REWARDS, message(operator, STAKING_REWARDS, 'Set-Share', [], '{"Share":"0.1"}')))).toEqual([400, 'data must be a JSON object { Share: number }']);
  });
});

describe('message validation', () => {
  const submit = (tags: Tag[]) => [{ name: 'fingerprint-certificate', value: FINGERPRINT }, ...tags];

  for (const action of ['Add-Scores', 'Complete-Round', 'Claim-Rewards', 'Eval', 'Update-Roles-Typo']) {
    it(`refuses ${action}`, async () => {
      expect(await refusal(await push(gateway(), RELAY_REWARDS, message(operator, RELAY_REWARDS, action)))).toEqual([403, `${action} is not available through this gateway`]);
    });
  }

  it('refuses an action that belongs to another process', async () => {
    const body = message(operator, RELAY_REWARDS, 'Submit-Fingerprint-Certificate', submit([]));
    expect(await refusal(await push(gateway(), RELAY_REWARDS, body))).toEqual([403, 'Submit-Fingerprint-Certificate is not available through this gateway']);
  });

  it('refuses a message whose target is not the process in the path', async () => {
    const body = message(operator, RELAY_REWARDS, 'Submit-Fingerprint-Certificate', submit([]));
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'message target must be the process in the path']);
  });

  it('refuses tags the action does not take', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', submit([{ name: 'note', value: 'hello' }]));
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'tag note is not accepted for Submit-Fingerprint-Certificate']);
  });

  it('refuses a tag that appears twice in any case', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', submit([{ name: 'Fingerprint-Certificate', value: FINGERPRINT }]));
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'tag fingerprint-certificate appears more than once']);
  });

  it('refuses a variant that changes the execution device', async () => {
    const body = signItem(operator, {
      tags: [...BASE_TAGS.map((tag) => (tag.name === 'variant' ? { name: 'variant', value: 'ao.TN.1' } : tag)), { name: 'action', value: 'Submit-Fingerprint-Certificate' }, ...submit([])],
      target: OPERATOR_REGISTRY,
    });
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'tag variant has an invalid value']);
  });

  it('refuses a malformed fingerprint', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', [{ name: 'fingerprint-certificate', value: `${FINGERPRINT}00` }]);
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'tag fingerprint-certificate has an invalid value']);
  });

  it('refuses data on an action that takes none', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', submit([]), 'payload');
    expect(await refusal(await push(gateway(), OPERATOR_REGISTRY, body))).toEqual([400, 'Submit-Fingerprint-Certificate takes no data']);
  });

  it('refuses a corrupted signature', async () => {
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', submit([]));
    body[10] = (body[10] ?? 0) ^ 0xff;
    expect((await push(gateway(), OPERATOR_REGISTRY, body)).status).toBe(400);
  });

  it('refuses the wrong content type, method and query string', async () => {
    const handler = gateway();
    const body = message(operator, OPERATOR_REGISTRY, 'Submit-Fingerprint-Certificate', submit([]));
    expect((await push(handler, OPERATOR_REGISTRY, body, { 'content-type': 'application/json' })).status).toBe(415);
    expect((await get(handler, `/${OPERATOR_REGISTRY}~process@1.0/push`)).status).toBe(405);
    const withQuery = await handler(new Request(`http://gateway/${OPERATOR_REGISTRY}~process@1.0/push?debug=1`, { method: 'POST', headers: { 'content-type': 'application/ans104' }, body }));
    expect(withQuery.status).toBe(400);
    expect(node.pushes()).toHaveLength(0);
  });
});

describe('repeated messages', () => {
  it('answers a repeated message from the record without sending it again', async () => {
    const handler = gateway();
    const body = message(operator, RELAY_REWARDS, 'Set-Delegate');
    const first = await push(handler, RELAY_REWARDS, body);
    const second = await push(handler, RELAY_REWARDS, body);
    expect(second.status).toBe(200);
    expect(second.headers.get('slot')).toBe(first.headers.get('slot'));
    expect(node.pushes()).toHaveLength(1);
  });

  it('records only messages the node accepted', async () => {
    const handler = gateway();
    const body = message(operator, RELAY_REWARDS, 'Set-Delegate');
    node.pushStatus = 400;
    expect((await push(handler, RELAY_REWARDS, body)).status).toBe(400);
    node.pushStatus = 200;
    expect((await push(handler, RELAY_REWARDS, body)).status).toBe(200);
    expect(node.pushes()).toHaveLength(2);
  });

  it('limits messages per signer', async () => {
    const handler = gateway({ perMinute: 1 });
    expect((await push(handler, RELAY_REWARDS, message(operator, RELAY_REWARDS, 'Set-Delegate'))).status).toBe(200);
    const second = message(operator, RELAY_REWARDS, 'Set-Delegate', [{ name: 'address', value: stranger.address }]);
    expect(await refusal(await push(handler, RELAY_REWARDS, second))).toEqual([429, 'too many messages from this signer']);
  });

  it('answers 502 when the node cannot be asked about the operator', async () => {
    node.available = false;
    const body = message(operator, RELAY_REWARDS, 'Set-Delegate');
    expect((await push(gateway(), RELAY_REWARDS, body)).status).toBe(502);
  });
});

describe('admin writes', () => {
  const team = randomSigner();
  const block = () => message(team, OPERATOR_REGISTRY, 'Block-Operator-Address', [{ name: 'address', value: stranger.address }]);

  it('refuses admin actions that are not exposed', async () => {
    node.roles.set(OPERATOR_REGISTRY, { admin: { [team.address]: true } });
    expect(await refusal(await push(gateway({ adminSigners: [team.address] }), OPERATOR_REGISTRY, block()))).toEqual([403, 'Block-Operator-Address is not available through this gateway']);
  });

  it('refuses a role holder that is not a configured admin signer', async () => {
    node.roles.set(OPERATOR_REGISTRY, { admin: { [team.address]: true } });
    const handler = gateway({ adminActions: ['operator-registry:Block-Operator-Address'], adminSigners: [operator.address] });
    expect(await refusal(await push(handler, OPERATOR_REGISTRY, block()))).toEqual([403, 'signer may not send admin actions through this gateway']);
  });

  it('refuses a configured admin signer that does not hold the role', async () => {
    node.roles.set(OPERATOR_REGISTRY, { 'Unblock-Operator-Address': { [team.address]: true } });
    const handler = gateway({ adminActions: ['operator-registry:Block-Operator-Address'], adminSigners: [team.address] });
    expect(await refusal(await push(handler, OPERATOR_REGISTRY, block()))).toEqual([403, 'signer does not hold the admin or Block-Operator-Address role']);
    expect(node.pushes()).toHaveLength(0);
  });

  for (const role of ['admin', 'Block-Operator-Address']) {
    it(`forwards an exposed admin action from a configured signer holding the ${role} role`, async () => {
      node.roles.set(OPERATOR_REGISTRY, { [role]: { [team.address]: true } });
      const handler = gateway({ adminActions: ['operator-registry:Block-Operator-Address'], adminSigners: [team.address] });
      expect((await push(handler, OPERATOR_REGISTRY, block())).status).toBe(200);
      expect(node.pushes()).toHaveLength(1);
    });
  }

  it('refuses a role grant to an address that is not checksummed', async () => {
    const grant = JSON.stringify({ Grant: { [team.address.toLowerCase()]: ['admin'] } });
    const body = message(team, RELAY_REWARDS, 'Update-Roles', [], grant);
    const handler = gateway({ adminActions: ['relay-rewards:Update-Roles'], adminSigners: [team.address] });
    expect((await push(handler, RELAY_REWARDS, body)).status).toBe(400);
  });
});

describe('reads', () => {
  it('relays an allowed view with its parameters', async () => {
    const response = await get(gateway(), `/${RELAY_REWARDS}~process@1.0/as/rewards?address=${operator.address}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ view: 'rewards', query: `?address=${operator.address}` });
  });

  it('serves a repeated read from the cache', async () => {
    const handler = gateway();
    await get(handler, `/${STAKING_REWARDS}~process@1.0/as/last_snapshot`);
    await get(handler, `/${STAKING_REWARDS}~process@1.0/as/last_snapshot`);
    expect(node.requests).toHaveLength(1);
  });

  it('does not cache a failed read', async () => {
    const handler = gateway();
    node.views.set(`${STAKING_REWARDS}/as/status`, { status: 500, body: '{}' });
    expect((await get(handler, `/${STAKING_REWARDS}~process@1.0/as/status`)).status).toBe(500);
    node.views.delete(`${STAKING_REWARDS}/as/status`);
    expect((await get(handler, `/${STAKING_REWARDS}~process@1.0/as/status`)).status).toBe(200);
  });

  it('refuses views and parameters it does not list', async () => {
    const handler = gateway();
    expect((await get(handler, `/${OPERATOR_REGISTRY}~process@1.0/as/dump`)).status).toBe(404);
    expect((await get(handler, `/${OPERATOR_REGISTRY}~process@1.0/as/operator?address=${operator.address}&debug=1`)).status).toBe(400);
    expect((await get(handler, `/${OPERATOR_REGISTRY}~process@1.0/as/operator?address=nope`)).status).toBe(400);
    expect((await get(handler, `/${OPERATOR_REGISTRY}~process@1.0/as/operator?address=${operator.address}&address=${stranger.address}`)).status).toBe(400);
    expect(node.requests).toHaveLength(0);
  });

  it('serves the result of a message only once the gateway has sent it', async () => {
    const handler = gateway();
    expect((await get(handler, `/${RELAY_REWARDS}~process@1.0/compute&slot=1/results/output/data`)).status).toBe(404);
    await push(handler, RELAY_REWARDS, message(operator, RELAY_REWARDS, 'Set-Delegate'));
    const output = await get(handler, `/${RELAY_REWARDS}~process@1.0/compute&slot=1/results/output/data`);
    expect(output.status).toBe(200);
    expect(await output.text()).toBe('OK');
  });

  it('answers nothing outside the process routes', async () => {
    const handler = gateway();
    for (const path of ['/', '/~meta@1.0/info', `/${OPERATOR_REGISTRY}%7Eprocess@1.0/as/status`, `//${OPERATOR_REGISTRY}~process@1.0/as/status`, `/${Buffer.alloc(32, 9).toString('base64url')}~process@1.0/as/status`, `/${OPERATOR_REGISTRY}~process@1.0/now/status`, `/${OPERATOR_REGISTRY}~process@1.0/as/status/~meta@1.0/info`]) {
      expect([path, (await get(handler, path)).status]).toEqual([path, 404]);
    }
    expect(node.requests).toHaveLength(0);
  });
});

describe('http', () => {
  it('answers CORS preflight for browser writes', async () => {
    const response = await gateway()(new Request(`http://gateway/${OPERATOR_REGISTRY}~process@1.0/push`, { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, codec-device');
    expect(response.headers.get('access-control-expose-headers')).toBe('slot');
  });

  it('reports health', async () => {
    expect((await get(gateway(), '/healthz')).status).toBe(200);
  });
});
