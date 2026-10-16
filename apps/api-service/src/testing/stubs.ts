import type { BatchLookupRequest, GeoLocation } from '@anyone-protocol/geo-ip-client';
import type { DetailsDocument } from '../onionoo';
import type { QueryResponse } from '../victoria-metrics';

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body: string;
}

export class StubUpstreams {
  readonly requests: RecordedRequest[] = [];
  details: DetailsDocument = { relays: [] };
  query: QueryResponse = { status: 'success', data: { resultType: 'vector', result: [] } };
  queryRange: QueryResponse = { status: 'success', data: { resultType: 'matrix', result: [] } };
  operators: unknown = {};
  hardwareAnswer = 'Hardware relay info is updated.';
  failWith: number | undefined;
  readonly server = Bun.serve({ port: 0, fetch: (request) => this.#handle(request) });

  get address(): string {
    return `${this.server.hostname}:${this.server.port}`;
  }

  get url(): string {
    return `http://${this.address}`;
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push({ method: request.method, path: url.pathname, params: Object.fromEntries(url.searchParams), body: await request.text() });
    if (this.failWith) return new Response('upstream failure', { status: this.failWith });

    if (url.pathname === '/details') return Response.json(this.details);
    if (url.pathname.startsWith('/hardware/')) return new Response(this.hardwareAnswer);
    if (url.pathname === '/api/v1/query') return Response.json(this.query);
    if (url.pathname === '/api/v1/query_range') return Response.json(this.queryRange);
    if (url.pathname.endsWith('~process@1.0/as/operators')) return Response.json(this.operators);
    return new Response('not found', { status: 404 });
  }
}

export class StubGeoIpService {
  readonly requests: BatchLookupRequest[] = [];
  readonly server = Bun.serve({
    port: 0,
    routes: {
      '/lookup': { POST: (request) => this.#lookup(request) },
    },
  });

  constructor(readonly locations: Record<string, GeoLocation>) {}

  async #lookup(request: Request): Promise<Response> {
    const body = (await request.json()) as BatchLookupRequest;
    this.requests.push(body);
    return Response.json({
      results: body.addresses.map((address) => {
        const location = this.locations[address];
        return location ? { address, status: 'found', location } : { address, status: 'not-found' };
      }),
    });
  }
}
