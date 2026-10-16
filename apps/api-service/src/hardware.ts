export interface HardwareInfo {
  id: string;
  company: string;
  format: string;
  wallet: string;
  nftid: string;
  build: string;
  flags: string;
  fingerprint: string;
  serNums: { type: string; number: string }[];
  pubKeys: { type: string; number: string }[];
  certs: { type: string; signature: string }[];
}

export interface FieldError {
  type: 'field';
  value?: unknown;
  msg: string;
  path: string;
  location: 'body';
}

type Check = [test: (text: string) => boolean, message: string];

const FINGERPRINT = /^[a-fA-F0-9]{40}$/;

const isNotEmpty = (text: string) => text.length > 0;

function notEmpty(field: string, message = `${field} should not be empty`): [string, Check[]] {
  return [field, [[isNotEmpty, message]]];
}

const RULES: [field: string, checks: Check[]][] = [
  notEmpty('id'),
  notEmpty('company'),
  notEmpty('format'),
  notEmpty('wallet'),
  [
    'fingerprint',
    [
      [isNotEmpty, 'fingerprint should not be empty'],
      [(text) => FINGERPRINT.test(text), 'fingerprint must be a 40 character hexadecimal string'],
    ],
  ],
  notEmpty('nftid'),
  notEmpty('build'),
  notEmpty('flags'),
  notEmpty('serNums'),
  notEmpty('serNums.*.type'),
  notEmpty('serNums.*.number'),
  notEmpty('pubKeys', 'ID should not be empty'),
  notEmpty('pubKeys.*.type'),
  notEmpty('pubKeys.*.number'),
  notEmpty('certs'),
  notEmpty('certs.*.type'),
  notEmpty('certs.*.signature'),
];

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expand(value: unknown, segments: string[], path: string[] = []): string[][] {
  const [key, ...rest] = segments;
  if (key === undefined) return [path];
  if (value != null && !isObjectLike(value)) {
    return key === '*' ? [] : [[...path, ...segments]];
  }
  const object = value ?? {};
  if (key === '*') {
    return Object.keys(object).flatMap((child) => expand(object[child], rest, [...path, child]));
  }
  return expand(object[key], rest, [...path, key]);
}

function valueAt(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), root);
}

function formatPath(path: string[]): string {
  return path.reduce((formatted, segment) => {
    if (segment.includes('.')) return `${formatted}["${segment}"]`;
    if (/^\d+$/.test(segment)) return `${formatted}[${segment}]`;
    return formatted ? `${formatted}.${segment}` : segment;
  }, '');
}

function asText(value: unknown): string {
  if (isObjectLike(value) && value.toString) {
    return typeof value.toString === 'function' ? String(value.toString()) : Object.prototype.toString.call(value);
  }
  if (value == null || (Number.isNaN(Number(value)) && !(value as { length?: number }).length)) return '';
  return String(value);
}

export function validateHardwareInfo(body: unknown): FieldError[] {
  return RULES.flatMap(([field, checks]) => {
    const paths = expand(body, field.split('.'));
    return checks.flatMap(([test, msg]) =>
      paths.flatMap((path) => {
        const value = valueAt(body, path);
        const values = Array.isArray(value) ? value : [value];
        return values.filter((item) => !test(asText(item))).map((item): FieldError => ({ type: 'field', value: item, msg, path: formatPath(path), location: 'body' }));
      }),
    );
  });
}
