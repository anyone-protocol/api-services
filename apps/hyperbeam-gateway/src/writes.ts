import type { Logger } from '@anyone-protocol/service-kit';
import { type ActionSpec, actionKey, findAction, InvalidMessage, messageTags, type OperatorEntry, type ProcessName, validateMessage } from './actions';
import { type DataItem, InvalidDataItem, parseDataItem, verifySigner } from './ans104';
import { type HyperbeamNode, NodeUnavailable, type NodeResponse } from './node';
import type { ProcessIds } from './processes';
import type { RateLimiter } from './rate-limit';
import type { AcceptedMessage, MessageStore } from './store';

export interface AdminPolicy {
  actions: ReadonlySet<string>;
  signers: ReadonlySet<string>;
}

export interface WriteOptions {
  processes: ProcessIds;
  node: HyperbeamNode;
  store: MessageStore;
  admin: AdminPolicy;
  limiter: RateLimiter;
  roles: RolesCache;
  logger: Logger;
  now?: () => number;
}

export type WriteResult = { kind: 'refused'; status: number; reason: string } | { kind: 'answered'; response: NodeResponse; repeat: boolean };

type RoleTable = Record<string, Record<string, unknown>>;

export class RolesCache {
  private readonly entries = new Map<string, { expiresAt: number; roles: Promise<RoleTable> }>();

  constructor(
    private readonly node: HyperbeamNode,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async holds(processId: string, address: string, roles: readonly string[]): Promise<boolean> {
    const table = await this.table(processId);
    return roles.some((role) => {
      const holders = table[role];
      return holders !== undefined && Object.hasOwn(holders, address);
    });
  }

  private table(processId: string): Promise<RoleTable> {
    const cached = this.entries.get(processId);
    if (cached && cached.expiresAt > this.now()) return cached.roles;

    const roles = this.node.view<unknown>(processId, 'roles').then((value) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as RoleTable) : {}));
    this.entries.set(processId, { expiresAt: this.now() + this.ttlMs, roles });
    roles.catch(() => this.entries.delete(processId));
    return roles;
  }
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function setKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

export function responseSlot(response: Pick<NodeResponse, 'slot' | 'body'>): string | null {
  if (response.slot !== null) return response.slot;
  try {
    const slot = (JSON.parse(response.body) as { slot?: unknown }).slot;
    return slot === undefined || slot === null ? null : String(slot);
  } catch {
    return null;
  }
}

export class WriteHandler {
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: WriteOptions) {
    this.now = options.now ?? Date.now;
  }

  async handle(process: ProcessName, processId: string, raw: Uint8Array): Promise<WriteResult> {
    let item: DataItem | undefined;
    let signer: string | undefined;
    let spec: ActionSpec | undefined;
    try {
      item = parseDataItem(raw);
      signer = verifySigner(item);
      if (item.target !== processId) throw new Refusal(400, 'message target must be the process in the path');

      const tags = messageTags(item.tags);
      const action = tags.get('action');
      if (!action) throw new Refusal(400, 'tag action is required');
      spec = findAction(process, action);
      if (!spec) throw new Refusal(403, `${action} is not available through this gateway`);
      validateMessage(spec, tags, item.data);

      const repeat = this.options.store.find(item.id);
      if (repeat) return this.answered(repeat, true, item, signer, spec);

      if (this.inFlight.has(item.id)) throw new Refusal(409, 'message is already being forwarded');
      if (!this.options.limiter.take(signer)) throw new Refusal(429, 'too many messages from this signer');

      await this.authorize(spec, signer, tags);
      return await this.forward(spec, processId, item, raw, signer);
    } catch (error) {
      const refusal = this.refusal(error);
      this.options.logger.info('message refused', { id: item?.id, signer, process, action: spec?.action, status: refusal.status, reason: refusal.reason });
      return refusal;
    }
  }

  private refusal(error: unknown): { kind: 'refused'; status: number; reason: string } {
    if (error instanceof Refusal) return { kind: 'refused', status: error.status, reason: error.message };
    if (error instanceof InvalidDataItem || error instanceof InvalidMessage) return { kind: 'refused', status: 400, reason: error.message };
    if (error instanceof NodeUnavailable) return { kind: 'refused', status: 502, reason: error.message };
    throw error;
  }

  private async authorize(spec: ActionSpec, signer: string, tags: ReadonlyMap<string, string>): Promise<void> {
    if (spec.audience === 'operator') {
      const entry = await this.options.node.view<Record<string, unknown> | null>(this.options.processes.id('operator-registry'), 'operator', { address: signer });
      const operator: OperatorEntry = { claimable: setKeys(entry?.claimable), verified: setKeys(entry?.verified) };
      const reason = spec.check(operator, tags);
      if (reason) throw new Refusal(403, reason);
      return;
    }

    if (!this.options.admin.actions.has(actionKey(spec.process, spec.action))) throw new Refusal(403, `${spec.action} is not available through this gateway`);
    if (!this.options.admin.signers.has(signer)) throw new Refusal(403, 'signer may not send admin actions through this gateway');
    const holdsRole = await this.options.roles.holds(this.options.processes.id(spec.process), signer, ['admin', spec.action]);
    if (!holdsRole) throw new Refusal(403, `signer does not hold the admin or ${spec.action} role`);
  }

  private async forward(spec: ActionSpec, processId: string, item: DataItem, raw: Uint8Array, signer: string): Promise<WriteResult> {
    this.inFlight.add(item.id);
    try {
      const response = await this.options.node.push(processId, raw);
      const slot = responseSlot(response);
      const accepted: AcceptedMessage = {
        id: item.id,
        processId,
        action: spec.action,
        signer,
        slot,
        status: response.status,
        body: response.body,
        contentType: response.contentType,
        acceptedAt: this.now(),
      };
      if (response.status >= 200 && response.status < 300) this.options.store.record(accepted);
      return this.answered(accepted, false, item, signer, spec);
    } finally {
      this.inFlight.delete(item.id);
    }
  }

  private answered(message: AcceptedMessage, repeat: boolean, item: DataItem, signer: string, spec: ActionSpec): WriteResult {
    this.options.logger.info(repeat ? 'message repeated' : 'message forwarded', { id: item.id, signer, process: spec.process, action: spec.action, status: message.status, slot: message.slot });
    return { kind: 'answered', repeat, response: { status: message.status, body: message.body, contentType: message.contentType, slot: message.slot, location: null } };
  }
}
