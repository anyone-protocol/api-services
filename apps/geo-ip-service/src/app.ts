import { BATCH_LOOKUP_PATH, type BatchLookupResponse, type LookupResult } from '@anyone-protocol/geo-ip-client';
import { createHealthReporter, healthResponse, type HealthCheck, type HealthStatus } from '@anyone-protocol/service-kit';
import { ASN, CITY, EDITIONS, type Edition, type GeoDatabases } from './databases';
import { isH3Resolution, MAX_H3_RESOLUTION } from './location';
import { Counter, METRICS_CONTENT_TYPE, metricFamily, Summary } from './metrics';

export interface ServerOptions {
  port: number;
  databases: GeoDatabases;
  maxBatchSize: number;
}

interface BatchRequest {
  addresses: string[];
  h3Resolution?: number;
}

const STATUS_WITHOUT_EDITION: Record<Edition, HealthStatus> = { [CITY]: 'down', [ASN]: 'degraded' };

const SINGLE_LOOKUP_STATUS: Record<LookupResult['status'], number> = { found: 200, 'not-found': 404, invalid: 400 };

const H3_RESOLUTION_ERROR = `h3Resolution must be an integer from 0 to ${MAX_H3_RESOLUTION}`;

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function parseBatch(body: unknown, maxBatchSize: number): BatchRequest | Response {
  const { addresses, h3Resolution } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(addresses) || !addresses.every((address) => typeof address === 'string')) {
    return errorResponse(400, 'body must be a JSON object with an addresses array of strings');
  }
  if (h3Resolution !== undefined && !isH3Resolution(h3Resolution)) {
    return errorResponse(400, H3_RESOLUTION_ERROR);
  }
  if (addresses.length > maxBatchSize) {
    return errorResponse(413, `batch holds ${addresses.length} addresses, the limit is ${maxBatchSize}`);
  }
  return { addresses, h3Resolution };
}

function parseH3Query(url: string): number | undefined | Response {
  const raw = new URL(url).searchParams.get('h3Resolution');
  if (raw === null) return undefined;
  const resolution = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return isH3Resolution(resolution) ? resolution : errorResponse(400, H3_RESOLUTION_ERROR);
}

function databaseCheck(databases: GeoDatabases, edition: Edition): HealthCheck {
  return () => {
    const { loaded, buildDate, loadedAt, lastError } = databases.state(edition);
    return { status: loaded ? 'ok' : STATUS_WITHOUT_EDITION[edition], buildDate, loadedAt, lastError };
  };
}

function createMetrics(databases: GeoDatabases) {
  const requests = new Counter('geoip_requests_total', 'Lookup requests by route and HTTP status code');
  const lookups = new Counter('geoip_lookups_total', 'Addresses looked up, by result');
  const batchDuration = new Summary('geoip_batch_duration_seconds', 'Time to answer a batch lookup');

  const render = () => {
    const states = EDITIONS.map((edition) => databases.state(edition));
    const timestamps = (field: 'buildDate' | 'loadedAt') =>
      states.flatMap((state) => (state[field] ? [{ labels: { edition: state.edition }, value: Date.parse(state[field]) / 1000 }] : []));

    return [
      metricFamily('geoip_database_loaded', 'gauge', 'Whether the database edition is loaded', states.map((state) => ({ labels: { edition: state.edition }, value: Number(state.loaded) }))),
      metricFamily('geoip_database_load_failed', 'gauge', 'Whether the last attempt to load the database edition failed', states.map((state) => ({ labels: { edition: state.edition }, value: Number(state.lastError !== null) }))),
      metricFamily('geoip_database_build_timestamp_seconds', 'gauge', 'Build time of the loaded database edition', timestamps('buildDate')),
      metricFamily('geoip_database_load_timestamp_seconds', 'gauge', 'Time the loaded database edition was loaded', timestamps('loadedAt')),
      requests.render(),
      lookups.render(),
      batchDuration.render(),
    ].join('\n') + '\n';
  };

  return { requests, lookups, batchDuration, render };
}

export function startServer({ port, databases, maxBatchSize }: ServerOptions) {
  const health = createHealthReporter('geo-ip-service', {
    checks: Object.fromEntries(EDITIONS.map((edition) => [edition, databaseCheck(databases, edition)])),
  });
  const metrics = createMetrics(databases);

  const finish = (route: string, response: Response) => {
    metrics.requests.inc({ route, code: String(response.status) });
    return response;
  };
  const unavailable = () => errorResponse(503, `${CITY} database is not loaded`);

  return Bun.serve({
    port,
    routes: {
      '/healthz': { GET: () => healthResponse(health()) },
      '/metrics': { GET: () => new Response(metrics.render(), { headers: { 'content-type': METRICS_CONTENT_TYPE } }) },

      [BATCH_LOOKUP_PATH]: {
        POST: async (request) => {
          const started = performance.now();
          if (!databases.ready) return finish('batch', unavailable());

          const batch = parseBatch(await request.json().catch(() => undefined), maxBatchSize);
          if (batch instanceof Response) return finish('batch', batch);

          const results = batch.addresses.map((address) => ({ address, ...databases.lookup(address, batch.h3Resolution) }));
          results.forEach(({ status }) => metrics.lookups.inc({ status }));
          const response = Response.json({ results } satisfies BatchLookupResponse);
          metrics.batchDuration.observe((performance.now() - started) / 1000);
          return finish('batch', response);
        },
      },

      '/lookup/:address': {
        GET: (request) => {
          if (!databases.ready) return finish('single', unavailable());

          const h3Resolution = parseH3Query(request.url);
          if (h3Resolution instanceof Response) return finish('single', h3Resolution);

          const { address } = request.params;
          const result = databases.lookup(address, h3Resolution);
          metrics.lookups.inc({ status: result.status });
          return finish('single', Response.json({ address, ...result }, { status: SINGLE_LOOKUP_STATUS[result.status] }));
        },
      },
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  });
}
