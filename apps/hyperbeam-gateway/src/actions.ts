import { isAddress, isChecksumAddress, type Tag } from './ans104';

export const PROCESSES = ['operator-registry', 'relay-rewards', 'staking-rewards'] as const;
export type ProcessName = (typeof PROCESSES)[number];

export interface OperatorEntry {
  claimable: string[];
  verified: string[];
}

export type OperatorCheck = (entry: OperatorEntry, tags: ReadonlyMap<string, string>) => string | undefined;

export type DataRule =
  | { kind: 'none' }
  | { kind: 'json'; maxBytes: number; valid: (value: unknown) => boolean; description: string }
  | { kind: 'fingerprints'; max: number };

export interface TagRule {
  required: boolean;
  valid: (value: string) => boolean;
}

interface CommonSpec {
  process: ProcessName;
  action: string;
  tags: Record<string, TagRule>;
  data: DataRule;
}

export type ActionSpec = (CommonSpec & { audience: 'operator'; check: OperatorCheck }) | (CommonSpec & { audience: 'admin' });

export const FINGERPRINT = /^[0-9A-F]{40}$/;

const fingerprint = (value: string) => FINGERPRINT.test(value);
const roundTimestamp = (value: string) => /^\d{1,16}$/.test(value);
const share = (value: string) => /^(0|1)(\.\d{1,18})?$/.test(value) && Number(value) <= 1;
const required = (valid: (value: string) => boolean): TagRule => ({ required: true, valid });
const optional = (valid: (value: string) => boolean): TagRule => ({ required: false, valid });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

const KIB = 1024;
const configuration: DataRule = { kind: 'json', maxBytes: 64 * KIB, valid: isRecord, description: 'a JSON object' };

const roleMap = (value: unknown) =>
  isRecord(value) && Object.entries(value).every(([address, roles]) => isChecksumAddress(address) && Array.isArray(roles) && roles.length > 0 && roles.every((role) => typeof role === 'string' && role.length > 0));

const roleUpdate: DataRule = {
  kind: 'json',
  maxBytes: 16 * KIB,
  valid: (value) => isRecord(value) && hasOnlyKeys(value, ['Grant', 'Revoke']) && (value.Grant !== undefined || value.Revoke !== undefined) && [value.Grant, value.Revoke].every((map) => map === undefined || roleMap(map)),
  description: 'a JSON object with Grant and/or Revoke maps of checksummed address to role names',
};

const certificates: DataRule = {
  kind: 'json',
  maxBytes: 512 * KIB,
  valid: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((cert) => isRecord(cert) && hasOnlyKeys(cert, ['f', 'a', 'hw']) && typeof cert.f === 'string' && fingerprint(cert.f) && typeof cert.a === 'string' && isAddress(cert.a) && (cert.hw === undefined || typeof cert.hw === 'boolean')),
  description: 'a JSON array of { f: fingerprint, a: address, hw?: boolean }',
};

const isOperator: OperatorCheck = (entry) => (entry.claimable.length > 0 || entry.verified.length > 0 ? undefined : 'signer is not a registered operator');

function admin(process: ProcessName, action: string, tags: Record<string, TagRule> = {}, data: DataRule = { kind: 'none' }): ActionSpec {
  return { process, action, audience: 'admin', tags, data };
}

export const ACTIONS: readonly ActionSpec[] = [
  {
    process: 'operator-registry',
    action: 'Submit-Fingerprint-Certificate',
    audience: 'operator',
    tags: { 'fingerprint-certificate': required(fingerprint) },
    data: { kind: 'none' },
    check: (entry, tags) => (entry.claimable.includes(tags.get('fingerprint-certificate') ?? '') ? undefined : 'fingerprint is not claimable by the signer'),
  },
  {
    process: 'operator-registry',
    action: 'Renounce-Fingerprint-Certificate',
    audience: 'operator',
    tags: { fingerprint: required(fingerprint) },
    data: { kind: 'none' },
    check: (entry, tags) => (entry.verified.includes(tags.get('fingerprint') ?? '') ? undefined : 'fingerprint is not verified to the signer'),
  },
  {
    process: 'relay-rewards',
    action: 'Set-Delegate',
    audience: 'operator',
    tags: { address: optional(isAddress), share: optional(share) },
    data: { kind: 'none' },
    check: isOperator,
  },
  {
    process: 'staking-rewards',
    action: 'Set-Share',
    audience: 'operator',
    tags: {},
    data: { kind: 'json', maxBytes: KIB, valid: (value) => isRecord(value) && hasOnlyKeys(value, ['Share']) && typeof value.Share === 'number' && Number.isFinite(value.Share), description: 'a JSON object { Share: number }' },
    check: isOperator,
  },
  admin('operator-registry', 'Admin-Submit-Operator-Certificates', {}, certificates),
  admin('operator-registry', 'Remove-Fingerprint-Certificate', { fingerprint: required(fingerprint) }),
  admin('operator-registry', 'Block-Operator-Address', { address: required(isAddress) }),
  admin('operator-registry', 'Unblock-Operator-Address', { address: required(isAddress) }),
  admin('operator-registry', 'Add-Registration-Credit', { address: required(isAddress), fingerprint: required(fingerprint) }),
  admin('operator-registry', 'Remove-Registration-Credit', { address: required(isAddress), fingerprint: required(fingerprint) }),
  admin('operator-registry', 'Add-Verified-Hardware', {}, { kind: 'fingerprints', max: 1000 }),
  admin('operator-registry', 'Remove-Verified-Hardware', {}, { kind: 'fingerprints', max: 1000 }),
  admin('relay-rewards', 'Update-Configuration', {}, configuration),
  admin('relay-rewards', 'Cancel-Round', { 'round-timestamp': required(roundTimestamp) }),
  admin('staking-rewards', 'Update-Configuration', {}, configuration),
  admin('staking-rewards', 'Update-Shares-Configuration', {}, configuration),
  admin('staking-rewards', 'Toggle-Feature-Shares', {}, { kind: 'json', maxBytes: KIB, valid: (value) => isRecord(value) && hasOnlyKeys(value, ['Enabled']) && typeof value.Enabled === 'boolean', description: 'a JSON object { Enabled: boolean }' }),
  admin('staking-rewards', 'Cancel-Round', { 'round-timestamp': required(roundTimestamp) }),
  ...PROCESSES.map((process) => admin(process, 'Update-Roles', {}, roleUpdate)),
];

export const actionKey = (process: ProcessName, action: string) => `${process}:${action}`;

const BY_KEY = new Map(ACTIONS.map((spec) => [actionKey(spec.process, spec.action), spec]));

export function findAction(process: ProcessName, action: string): ActionSpec | undefined {
  return BY_KEY.get(actionKey(process, action));
}

export const ADMIN_ACTION_KEYS: ReadonlySet<string> = new Set(ACTIONS.filter((spec) => spec.audience === 'admin').map((spec) => actionKey(spec.process, spec.action)));

const MESSAGE_TAGS: Record<string, TagRule> = {
  type: required((value) => value === 'Message'),
  'data-protocol': required((value) => value === 'ao'),
  variant: required((value) => value === 'ao.N.1'),
  action: required(() => true),
  'require-codec': optional((value) => value === 'application/json'),
  'ui-cache-key': optional((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value)),
};

export class InvalidMessage extends Error {}

export function messageTags(tags: readonly Tag[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const { name, value } of tags) {
    const key = name.toLowerCase();
    if (byName.has(key)) throw new InvalidMessage(`tag ${key} appears more than once`);
    byName.set(key, value);
  }
  return byName;
}

export function validateMessage(spec: ActionSpec, tags: ReadonlyMap<string, string>, data: Uint8Array): void {
  const rules = { ...MESSAGE_TAGS, ...spec.tags };
  for (const [name, value] of tags) {
    const rule = rules[name];
    if (!rule) throw new InvalidMessage(`tag ${name} is not accepted for ${spec.action}`);
    if (!rule.valid(value)) throw new InvalidMessage(`tag ${name} has an invalid value`);
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.required && !tags.has(name)) throw new InvalidMessage(`tag ${name} is required for ${spec.action}`);
  }
  validateData(spec, data);
}

function validateData(spec: ActionSpec, data: Uint8Array): void {
  const rule = spec.data;
  if (rule.kind === 'none') {
    if (data.length > 0) throw new InvalidMessage(`${spec.action} takes no data`);
    return;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new InvalidMessage('data is not valid UTF-8');
  }

  if (rule.kind === 'fingerprints') {
    const fingerprints = text.split(',');
    if (fingerprints.length > rule.max || !fingerprints.every(fingerprint)) throw new InvalidMessage(`data must be up to ${rule.max} comma-separated fingerprints`);
    return;
  }

  if (data.length > rule.maxBytes) throw new InvalidMessage(`data is larger than ${rule.maxBytes} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidMessage(`data must be ${rule.description}`);
  }
  if (!rule.valid(value)) throw new InvalidMessage(`data must be ${rule.description}`);
}
