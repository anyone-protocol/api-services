import type { GeoIpClient } from '@anyone-protocol/geo-ip-client';
import { type CheckResult, createHealthReporter, healthResponse, type Logger } from '@anyone-protocol/service-kit';
import type { BunRequest } from 'bun';
import { errorPage, html, json, notFound, preflight, readJsonBody, relayedText } from './express-compat';
import { type HardwareInfo, validateHardwareInfo } from './hardware';
import type { Onionoo, Relay } from './onionoo';
import type { OperatorRegistry } from './operator-registry';
import { fingerprintMap, GeolocationUnavailable, relayMap } from './relay-maps';
import type { UnsDomains } from './uns-domains';
import type { RelayMetrics } from './victoria-metrics';

export interface ServerOptions {
  port: number;
  onionoo: Onionoo;
  relayMetrics: RelayMetrics;
  geo: GeoIpClient;
  hexagonResolution: number;
  operatorRegistry: OperatorRegistry;
  unsDomains: UnsDomains;
  logger: Logger;
}

type Handler = (request: BunRequest) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;

const RELAY_METRICS = {
  '/total-relays': 'total_relays',
  '/total-observed-bandwidth': 'total_observed_bandwidth',
  '/average-bandwidth-rate': 'average_bandwidth_rate',
};

function relaySummary({ nickname, fingerprint, running, consensus_weight, observed_bandwidth, measured }: Relay) {
  return { nickname, fingerprint, running, consensus_weight, observed_bandwidth, measured };
}

function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

function geoIpCheck(geo: GeoIpClient): CheckResult {
  const state = geo.state();
  return { status: state.failing ? 'degraded' : 'ok', ...state };
}

function withTrailingSlashes(routes: Routes): Routes {
  return Object.fromEntries(Object.entries(routes).flatMap(([path, methods]) => [[path, methods], [`${path}/`, methods]]));
}

export function startServer({ port, onionoo, relayMetrics, geo, hexagonResolution, operatorRegistry, unsDomains, logger }: ServerOptions) {
  const health = createHealthReporter('api-service', { checks: { geoIp: () => geoIpCheck(geo) } });

  const answer =
    (failure: string, handle: Handler): Handler =>
    async (request) => {
      try {
        return await handle(request);
      } catch (error) {
        if (error instanceof GeolocationUnavailable) {
          logger.warn(error.message, { path: new URL(request.url).pathname });
          return html(request, 'Relay geolocation is unavailable', 503);
        }
        logger.error(failure, { error });
        return html(request, failure, 500);
      }
    };

  const metricRoutes: Routes = Object.fromEntries(
    Object.entries(RELAY_METRICS).flatMap(([path, metric]) => [
      [path, { GET: answer('Error querying VictoriaMetrics', async (request) => json(request, await relayMetrics.range(metric, searchParams(request)))) }],
      [`${path}-latest`, { GET: answer('Error querying VictoriaMetrics', async (request) => json(request, await relayMetrics.latest(metric))) }],
    ]),
  );

  const routes: Routes = {
    ...metricRoutes,

    '/relays/:fingerprint': {
      GET: answer('Error querying Onionoo', async (request) => {
        const { relays } = await onionoo.details();
        const relay = relays.find((candidate) => candidate.fingerprint === request.params.fingerprint);
        return relay ? json(request, relaySummary(relay)) : html(request, 'Relay not found', 404);
      }),
    },

    '/relays': {
      GET: answer('Error querying Onionoo', async (request) => {
        const fingerprints = searchParams(request).get('fingerprints');
        if (!fingerprints) return html(request, 'Fingerprints are required', 400);

        const wanted = new Set(fingerprints.split(','));
        const { relays } = await onionoo.details();
        return json(request, relays.filter((relay) => wanted.has(relay.fingerprint)).map(relaySummary));
      }),
    },

    '/relay-map': {
      GET: answer('Error querying relay map', async (request) => {
        const { relays } = await onionoo.details();
        return json(request, await relayMap(relays, geo, hexagonResolution));
      }),
    },

    '/fingerprint-map': {
      GET: answer('Error querying relay map', async (request) => {
        const { relays } = await onionoo.details();
        return json(request, await fingerprintMap(relays, geo, hexagonResolution));
      }),
    },

    '/hardware': {
      POST: answer('Error posting hardware info', async (request) => {
        const body = await readJsonBody(request);
        if (body instanceof Response) return body;

        const errors = validateHardwareInfo(body);
        if (errors.length > 0) return json(request, { errors }, 400);

        return relayedText(request, await onionoo.updateHardwareInfo(body as HardwareInfo));
      }),
    },

    '/operators': {
      GET: answer('Error querying operators', async (request) => {
        const operators = await operatorRegistry.operators();
        if (searchParams(request).get('withDomains') !== 'true') return json(request, operators);

        const domains = await unsDomains.anyoneDomains();
        const ownedBy = (address: string) => domains.filter((domain) => domain.owner?.toLowerCase() === address.toLowerCase());
        return json(request, operators.map((address) => ({ address, domains: ownedBy(address) })));
      }),
    },

    '/anyone-domains': {
      GET: answer('Error querying anyone domains', async (request) => json(request, await unsDomains.anyoneDomains())),
    },
  };

  return Bun.serve({
    port,
    routes: {
      ...withTrailingSlashes(routes),
      '/healthz': { GET: () => healthResponse(health()) },
    },
    fetch: (request) => (request.method === 'OPTIONS' ? preflight(request) : notFound(request)),
    error: (error) => {
      logger.error('Unhandled request error', { error });
      return errorPage(500, 'Internal Server Error');
    },
  });
}
