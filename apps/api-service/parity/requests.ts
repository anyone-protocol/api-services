export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ParityRequest {
  method?: 'GET' | 'POST' | 'OPTIONS';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  normalize?: (body: Json) => Json;
  normalizePair?: (old: Json, ported: Json) => [Json, Json];
  conditional?: boolean;
  bodyNotCompared?: string;
}

export interface ParityContext {
  fingerprints: string[];
  rangeStart: number;
  rangeEnd: number;
}

const UNKNOWN_FINGERPRINT = '0'.repeat(40);
const RELAY_METRIC_PATHS = ['/total-relays', '/total-observed-bandwidth', '/average-bandwidth-rate'];

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedBy(keyOf: (item: Json) => string) {
  return (body: Json): Json => (Array.isArray(body) ? [...body].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) : body);
}

function field(key: string) {
  return (item: Json) => String(isObject(item) ? item[key] : item);
}

const sorted = sortedBy(String);

function operatorsWithDomains(body: Json): Json {
  if (!Array.isArray(body)) return body;
  const withSortedDomains = body.map((operator) => (isObject(operator) ? { ...operator, domains: sortedBy(field('tokenId'))(operator.domains ?? []) } : operator));
  return sortedBy(field('address'))(withSortedDomains);
}

function commonSamples(old: Json, ported: Json): [Json, Json] {
  if (!isObject(old) || !isObject(ported)) return [old, ported];
  const timestamps = (samples: Json | undefined) => new Set(Array.isArray(samples) ? samples.map((sample) => (Array.isArray(sample) ? sample[0] : null)) : []);
  const keep = (body: { [key: string]: Json }, other: { [key: string]: Json }) =>
    Object.fromEntries(
      Object.entries(body).map(([status, samples]) => {
        const shared = timestamps(other[status]);
        return [status, Array.isArray(samples) ? samples.filter((sample) => Array.isArray(sample) && shared.has(sample[0] ?? null)) : samples];
      }),
    );
  return [keep(old, ported), keep(ported, old)];
}

const INVALID_HARDWARE_INFO = {
  id: ['', 'id'],
  company: 'company',
  fingerprint: 'not-a-fingerprint',
  serNums: [{ type: '' }, 'text', { type: 0 }, []],
  pubKeys: [],
  certs: { first: { type: 'type' }, 'with.dot': { signature: '' } },
};

export function parityRequests({ fingerprints, rangeStart, rangeEnd }: ParityContext): ParityRequest[] {
  const [first = UNKNOWN_FINGERPRINT, second = first, third = second] = fingerprints;
  const json = { 'content-type': 'application/json' };

  return [
    ...RELAY_METRIC_PATHS.flatMap((path): ParityRequest[] => [
      { path: `${path}-latest` },
      { path: `${path}?from=${rangeStart}&to=${rangeEnd}&interval=6h` },
      { path: `${path}?from=-3d&interval=12h`, normalizePair: commonSamples },
      { path, normalizePair: commonSamples },
    ]),

    { path: `/relays/${first}` },
    { path: `/relays/${first}/` },
    { path: `/relays/${UNKNOWN_FINGERPRINT}` },
    { path: `/relays?fingerprints=${[first, second, third, UNKNOWN_FINGERPRINT].join(',')}`, normalize: sortedBy(field('fingerprint')) },
    { path: `/relays/?fingerprints=${first}` },
    { path: '/relays' },
    { path: '/relays?fingerprints=' },

    { path: '/relay-map/', normalize: sortedBy(field('index')) },
    { path: '/relay-map', normalize: sortedBy(field('index')) },
    { path: '/fingerprint-map/' },
    { path: '/fingerprint-map' },

    { path: '/operators', normalize: sorted },
    { path: '/operators?withDomains=true', normalize: operatorsWithDomains },
    { path: '/operators?withDomains=false', normalize: sorted },
    { path: '/anyone-domains', normalize: sortedBy(field('tokenId')) },

    { method: 'POST', path: '/hardware', headers: json, body: '{}' },
    { method: 'POST', path: '/hardware', headers: json, body: '' },
    { method: 'POST', path: '/hardware', headers: json, body: JSON.stringify(INVALID_HARDWARE_INFO) },
    { method: 'POST', path: '/hardware', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(INVALID_HARDWARE_INFO) },
    { method: 'POST', path: '/hardware', headers: json, body: '{"id":', bodyNotCompared: 'Express in development mode writes the parser stack trace into the error page' },

    { method: 'OPTIONS', path: '/relays', headers: { origin: 'https://example.org', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' } },
    { method: 'OPTIONS', path: '/fingerprint-map/', headers: { origin: 'https://example.org', 'access-control-request-method': 'GET' } },
    { path: '/missing' },
    { method: 'POST', path: '/relays' },

    { path: `/relays/${first}`, conditional: true },
    { path: '/total-relays-latest', conditional: true },
  ];
}
