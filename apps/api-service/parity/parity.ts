import { parseArgs } from 'node:util';
import { type Json, type ParityRequest, parityRequests } from './requests';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Difference {
  path: string;
  old: unknown;
  ported: unknown;
}

const USAGE = `Usage: bun apps/api-service/parity/parity.ts --old <url> --new <url> [options]

Replays a fixed request set against the running api-service (--old) and the
ported one (--new) and reports every difference in status, body and the
carried headers. Exits 1 when a difference remains after the retries.

Options:
  --attempts <n>          tries per request before a difference is reported (default 3)
  --retry-delay <ms>      wait between tries (default 3000)
  --long-query-bytes <n>  length of the long relay request (default 79000)
  --fingerprints <list>   comma separated relays to ask for, instead of the
                          first three keys of the old fingerprint map`;

const CARRIED_HEADERS = ['content-type', 'etag', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'vary'];
const PER_RESPONSE_HEADERS = ['date', 'content-length'];
const SIX_HOURS_SECONDS = 6 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const SHOWN_DIFFERENCES = 5;
const FLOAT_TOLERANCE = 1e-9;

const { values: options } = parseArgs({
  options: {
    old: { type: 'string' },
    new: { type: 'string' },
    attempts: { type: 'string', default: '3' },
    'retry-delay': { type: 'string', default: '3000' },
    'long-query-bytes': { type: 'string', default: '79000' },
    fingerprints: { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (options.help || !options.old || !options.new) {
  console.log(USAGE);
  process.exit(options.help ? 0 : 2);
}

const OLD = options.old;
const PORTED = options.new;
const ATTEMPTS = Number(options.attempts);
const RETRY_DELAY_MS = Number(options['retry-delay']);
const LONG_QUERY_BYTES = Number(options['long-query-bytes']);

function label(request: ParityRequest): string {
  const text = `${request.method ?? 'GET'} ${request.path}${request.conditional ? ' (If-None-Match)' : ''}${request.body !== undefined ? ` ${request.body.slice(0, 40)}` : ''}`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function withNonce(path: string, nonce: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}_parity=${nonce}`;
}

async function capture(base: string, request: ParityRequest, nonce: string, extraHeaders: Record<string, string> = {}): Promise<Captured> {
  const response = await fetch(new URL(withNonce(request.path, nonce), base), {
    method: request.method ?? 'GET',
    headers: { ...request.headers, ...extraHeaders },
    body: request.body,
    redirect: 'manual',
  });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

async function captureBoth(request: ParityRequest): Promise<[Captured, Captured]> {
  const nonce = crypto.randomUUID();
  const pair = await Promise.all([capture(OLD, request, nonce), capture(PORTED, request, nonce)]);
  if (!request.conditional) return pair;
  return Promise.all([
    capture(OLD, request, nonce, { 'if-none-match': pair[0].headers.etag ?? '' }),
    capture(PORTED, request, nonce, { 'if-none-match': pair[1].headers.etag ?? '' }),
  ]);
}

function parseJson(captured: Captured): Json | undefined {
  if (!captured.headers['content-type']?.startsWith('application/json')) return undefined;
  try {
    return JSON.parse(captured.body) as Json;
  } catch {
    return undefined;
  }
}

interface Comparison {
  differences: Difference[];
  closeNumbers: number;
}

function compareJson(old: unknown, ported: unknown, path = '$', result: Comparison = { differences: [], closeNumbers: 0 }): Comparison {
  if (typeof old === 'number' && typeof ported === 'number' && old !== ported && Math.abs(old - ported) <= FLOAT_TOLERANCE) {
    result.closeNumbers++;
    return result;
  }
  const bothObjects = typeof old === 'object' && old !== null && typeof ported === 'object' && ported !== null && Array.isArray(old) === Array.isArray(ported);
  if (!bothObjects) {
    if (!Object.is(old, ported)) result.differences.push({ path, old, ported });
    return result;
  }
  const keys = new Set([...Object.keys(old), ...Object.keys(ported)]);
  for (const key of keys) {
    compareJson((old as Record<string, unknown>)[key], (ported as Record<string, unknown>)[key], `${path}.${key}`, result);
  }
  return result;
}

function brief(value: unknown): string {
  const text = value === undefined ? 'missing' : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

interface BodyComparison {
  problems: string[];
  notes: string[];
}

function compareBodies(request: ParityRequest, old: Captured, ported: Captured): BodyComparison {
  if (request.bodyNotCompared) return { problems: [], notes: [`body not compared: ${request.bodyNotCompared}`] };
  const oldJson = parseJson(old);
  const portedJson = parseJson(ported);
  if (oldJson === undefined || portedJson === undefined) {
    return { problems: old.body === ported.body ? [] : [`body: old ${brief(old.body)}, new ${brief(ported.body)}`], notes: [] };
  }

  const normalize = request.normalize ?? ((body: Json) => body);
  const [oldBody, portedBody] = request.normalizePair ? request.normalizePair(normalize(oldJson), normalize(portedJson)) : [normalize(oldJson), normalize(portedJson)];
  const { differences, closeNumbers } = compareJson(oldBody, portedBody);
  return {
    problems:
      differences.length === 0
        ? []
        : [`body: ${differences.length} differences`, ...differences.slice(0, SHOWN_DIFFERENCES).map(({ path, old, ported }) => `  ${path}: old ${brief(old)}, new ${brief(ported)}`)],
    notes: closeNumbers === 0 ? [] : [`${closeNumbers} numbers differ by at most ${FLOAT_TOLERANCE}`],
  };
}

function headerProblems(old: Captured, ported: Captured): string[] {
  return CARRIED_HEADERS.flatMap((name) => {
    const [oldValue, portedValue] = [old.headers[name], ported.headers[name]];
    if (name === 'etag' && old.body !== ported.body) {
      return (oldValue === undefined) === (portedValue === undefined) ? [] : [`etag: old ${brief(oldValue)}, new ${brief(portedValue)}`];
    }
    return oldValue === portedValue ? [] : [`${name}: old ${brief(oldValue)}, new ${brief(portedValue)}`];
  });
}

function compare(request: ParityRequest, old: Captured, ported: Captured): BodyComparison {
  const statusProblems = old.status === ported.status ? [] : [`status: old ${old.status}, new ${ported.status}`];
  const body = compareBodies(request, old, ported);
  return { problems: [...statusProblems, ...headerProblems(old, ported), ...body.problems], notes: body.notes };
}

const otherHeaderDifferences = new Map<string, { count: number; example: string }>();

function recordOtherHeaders(old: Captured, ported: Captured) {
  const names = new Set([...Object.keys(old.headers), ...Object.keys(ported.headers)]);
  for (const name of names) {
    if (CARRIED_HEADERS.includes(name) || PER_RESPONSE_HEADERS.includes(name)) continue;
    const [oldValue, portedValue] = [old.headers[name], ported.headers[name]];
    if (oldValue === portedValue) continue;
    const kind = portedValue === undefined ? 'old only' : oldValue === undefined ? 'new only' : 'values differ';
    const key = `${name} (${kind})`;
    const entry = otherHeaderDifferences.get(key) ?? { count: 0, example: `old ${brief(oldValue)}, new ${brief(portedValue)}` };
    entry.count++;
    otherHeaderDifferences.set(key, entry);
  }
}

async function check(request: ParityRequest): Promise<BodyComparison> {
  for (let attempt = 1; ; attempt++) {
    const [old, ported] = await captureBoth(request);
    const outcome = compare(request, old, ported);
    if (outcome.problems.length === 0 || attempt >= ATTEMPTS) {
      recordOtherHeaders(old, ported);
      return outcome;
    }
    await Bun.sleep(RETRY_DELAY_MS);
  }
}

async function discoverFingerprints(): Promise<string[]> {
  if (options.fingerprints) return options.fingerprints.split(',');
  const response = await fetch(new URL(withNonce('/fingerprint-map/', crypto.randomUUID()), OLD));
  if (!response.ok) throw new Error(`old fingerprint map answered ${response.status}; pass --fingerprints`);
  return Object.keys((await response.json()) as Record<string, unknown>)
    .sort()
    .slice(0, 3);
}

async function longQuery(fingerprint: string): Promise<{ old: number; ported: number }> {
  const prefix = '/relays?fingerprints=';
  const count = Math.floor((LONG_QUERY_BYTES - prefix.length) / (fingerprint.length + 1));
  const path = prefix + Array.from({ length: count }, () => fingerprint).join(',');
  const status = (base: string) =>
    fetch(new URL(path, base))
      .then((response) => response.status)
      .catch(() => 0);
  return { old: await status(OLD), ported: await status(PORTED) };
}

const fingerprints = await discoverFingerprints();
const rangeEnd = Math.floor(Date.now() / 1000 / SIX_HOURS_SECONDS) * SIX_HOURS_SECONDS;
const requests = parityRequests({ fingerprints, rangeStart: rangeEnd - SEVEN_DAYS_SECONDS, rangeEnd });

console.log(`old ${OLD}\nnew ${PORTED}\nrelays ${fingerprints.join(', ')}\n`);

let failed = 0;
for (const request of requests) {
  const { problems, notes } = await check(request);
  if (problems.length > 0) failed++;
  console.log(`${problems.length === 0 ? 'ok  ' : 'DIFF'} ${label(request)}`);
  for (const line of [...problems, ...notes]) console.log(`       ${line}`);
}

const long = await longQuery(fingerprints[0] ?? '0'.repeat(40));
const longOk = long.ported === 200;
console.log(`${longOk ? 'ok  ' : 'FAIL'} GET /relays with a ${LONG_QUERY_BYTES} byte request line: old ${long.old}, new ${long.ported}`);

console.log('\nOther header differences, listed and not matched:');
for (const [key, { count, example }] of [...otherHeaderDifferences].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${key}: ${count} responses, ${example}`);
}
if (otherHeaderDifferences.size === 0) console.log('  none');

console.log(`\n${requests.length - failed} of ${requests.length} requests match${longOk ? '' : ', long request failed'}`);
process.exit(failed === 0 && longOk ? 0 : 1);
