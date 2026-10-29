import type { Server } from 'bun';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface OperatorEntry {
  claimable?: Record<string, boolean> | [];
  verified?: Record<string, boolean> | [];
}

export class StubNode {
  readonly requests: RecordedRequest[] = [];
  readonly operators = new Map<string, OperatorEntry>();
  readonly roles = new Map<string, Record<string, Record<string, boolean>>>();
  readonly views = new Map<string, { status: number; body: string }>();
  pushStatus = 200;
  available = true;
  private slot = 0;
  private server: Server<undefined> | undefined;

  get url(): string {
    return `http://127.0.0.1:${this.server?.port}`;
  }

  start(): this {
    this.server = Bun.serve({ port: 0, fetch: (request) => this.answer(request) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  pushes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method === 'POST');
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    this.requests.push({ method: request.method, path, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) });
    if (!this.available) return new Response('unavailable', { status: 503 });

    const match = /^\/([A-Za-z0-9_-]{43})~process@1\.0\/(.*)$/.exec(url.pathname);
    const processId = match?.[1] ?? '';
    const rest = match?.[2] ?? '';

    if (request.method === 'POST' && rest === 'push') {
      if (this.pushStatus !== 200) return new Response('Could not estimate price of request', { status: this.pushStatus });
      this.slot += 1;
      return Response.json({ slot: this.slot }, { headers: { slot: String(this.slot) } });
    }

    if (rest === 'as/operator') {
      return Response.json(this.operators.get(url.searchParams.get('address') ?? '') ?? { claimable: [], verified: [] });
    }
    if (rest === 'as/roles') return Response.json(this.roles.get(processId) ?? []);

    const configured = this.views.get(`${processId}/${rest}${url.search}`);
    if (configured) return new Response(configured.body, { status: configured.status, headers: { 'content-type': 'application/json' } });
    if (rest.startsWith('as/')) return Response.json({ view: rest.slice(3), query: url.search });
    if (/^compute&slot=\d+\/results\/output\/data$/.test(rest)) return new Response('OK', { headers: { 'content-type': 'text/plain' } });
    return new Response('not found', { status: 404 });
  }
}
