import { FINGERPRINT, type ProcessName } from './actions';
import { isAddress } from './ans104';
import type { HyperbeamNode, NodeResponse } from './node';
import type { MessageStore } from './store';

type ParamRule = (value: string) => boolean;

const MAX_FINGERPRINT_IDS = 100;

const address: ParamRule = isAddress;
const fingerprint: ParamRule = (value) => FINGERPRINT.test(value);
const fingerprintList: ParamRule = (value) => {
  const ids = value.split(',');
  return ids.length <= MAX_FINGERPRINT_IDS && ids.every(fingerprint);
};
const flag: ParamRule = (value) => /^(true|false|1|0)$/.test(value);

const RUNTIME_VIEWS: Record<string, Record<string, ParamRule>> = { roles: {}, version: {} };

export const VIEWS: Record<ProcessName, Record<string, Record<string, ParamRule>>> = {
  'operator-registry': {
    operator: { address },
    operators: {},
    scoring: {},
    fingerprints: { ids: fingerprintList },
    status: {},
    ...RUNTIME_VIEWS,
  },
  'relay-rewards': {
    rewards: { address, fingerprint },
    claimed: { address },
    delegate: { address },
    last_round: {},
    last_round_details: { address, fingerprint },
    last_snapshot: { redirect: flag },
    status: {},
    ...RUNTIME_VIEWS,
  },
  'staking-rewards': {
    rewards: { address },
    claimed: { address },
    shares: { address },
    last_round: {},
    last_round_data: { address },
    last_snapshot: {},
    status: {},
    ...RUNTIME_VIEWS,
  },
};

export type ReadResult = { kind: 'refused'; status: number; reason: string } | { kind: 'answered'; response: NodeResponse };

export function canonicalQuery(rules: Record<string, ParamRule>, params: URLSearchParams): string | { reason: string } {
  const accepted = new URLSearchParams();
  const seen = new Set<string>();
  for (const [name, value] of params) {
    const rule = rules[name];
    if (!rule) return { reason: `parameter ${name} is not accepted` };
    if (seen.has(name)) return { reason: `parameter ${name} appears more than once` };
    if (!rule(value)) return { reason: `parameter ${name} has an invalid value` };
    seen.add(name);
  }
  for (const name of Object.keys(rules).sort()) {
    const value = params.get(name);
    if (value !== null) accepted.set(name, value);
  }
  return accepted.toString();
}

interface CacheEntry {
  expiresAt: number;
  response: Promise<NodeResponse>;
}

export interface ReadOptions {
  node: HyperbeamNode;
  store: MessageStore;
  cacheTtlMs: number;
  maxCacheEntries?: number;
  now?: () => number;
}

export class ReadHandler {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(private readonly options: ReadOptions) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxCacheEntries ?? 10_000;
  }

  async view(process: ProcessName, processId: string, view: string, params: URLSearchParams): Promise<ReadResult> {
    const rules = VIEWS[process][view];
    if (!rules) return { kind: 'refused', status: 404, reason: `view ${view} is not available through this gateway` };
    const query = canonicalQuery(rules, params);
    if (typeof query !== 'string') return { kind: 'refused', status: 400, reason: query.reason };

    const path = `as/${view}${query ? `?${query}` : ''}`;
    return { kind: 'answered', response: await this.cached(`${processId}/${path}`, () => this.options.node.get(processId, path)) };
  }

  async slotOutput(processId: string, slot: string): Promise<ReadResult> {
    if (!this.options.store.hasSlot(processId, slot)) return { kind: 'refused', status: 404, reason: 'only results of messages sent through this gateway are available' };
    return { kind: 'answered', response: await this.options.node.get(processId, `compute&slot=${slot}/results/output/data`) };
  }

  private cached(key: string, load: () => Promise<NodeResponse>): Promise<NodeResponse> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.response;

    const response = load();
    this.cache.set(key, { expiresAt: now + this.options.cacheTtlMs, response });
    response.then(
      (value) => {
        if (value.status !== 200) this.cache.delete(key);
      },
      () => this.cache.delete(key),
    );
    this.evict();
    return response;
  }

  private evict(): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) return;
      this.cache.delete(key);
    }
  }
}
