import { createHealthReporter, healthResponse, type Logger } from '@anyone-protocol/service-kit';
import { NodeUnavailable, type NodeResponse } from './node';
import type { ProcessIds } from './processes';
import type { ReadHandler } from './reads';
import type { WriteHandler } from './writes';

export interface ServerOptions {
  port: number;
  maxBodyBytes: number;
  processes: ProcessIds;
  reads: ReadHandler;
  writes: WriteHandler;
  logger: Logger;
}

const PROCESS_PATH = /^\/([A-Za-z0-9_-]{43})~process@1\.0\/(.+)$/;
const VIEW_PATH = /^as\/([a-z_]+)$/;
const SLOT_OUTPUT_PATH = /^compute&slot=(\d{1,15})\/results\/output\/data$/;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'slot',
};

const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, codec-device',
  'access-control-max-age': '600',
};

function refused(status: number, reason: string): Response {
  return Response.json({ error: reason }, { status, headers: { ...CORS_HEADERS, 'x-content-type-options': 'nosniff' } });
}

function relayed(response: NodeResponse): Response {
  const headers: Record<string, string> = { ...CORS_HEADERS, 'x-content-type-options': 'nosniff' };
  if (response.contentType) headers['content-type'] = response.contentType;
  if (response.slot) headers.slot = response.slot;
  if (response.location && response.status >= 300 && response.status < 400) headers.location = response.location;
  return new Response(response.body, { status: response.status, headers });
}

export function createFetchHandler({ maxBodyBytes, processes, reads, writes, logger }: Omit<ServerOptions, 'port'>) {
  const health = createHealthReporter('hyperbeam-gateway');

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return healthResponse(health());
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });

    const match = PROCESS_PATH.exec(url.pathname);
    const processId = match?.[1] ?? '';
    const rest = match?.[2] ?? '';
    const process = processes.nameOf(processId);
    if (!process) return refused(404, 'not found');

    if (rest === 'push') {
      if (request.method !== 'POST') return refused(405, 'push takes POST');
      if (url.search) return refused(400, 'push takes no query parameters');
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/ans104') return refused(415, 'content-type must be application/ans104');
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > maxBodyBytes) return refused(413, `body is larger than ${maxBodyBytes} bytes`);
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length > maxBodyBytes) return refused(413, `body is larger than ${maxBodyBytes} bytes`);
      const result = await writes.handle(process, processId, body);
      return result.kind === 'refused' ? refused(result.status, result.reason) : relayed(result.response);
    }

    if (request.method !== 'GET') return refused(405, 'reads take GET');

    const view = VIEW_PATH.exec(rest);
    if (view) {
      const result = await reads.view(process, processId, view[1] ?? '', url.searchParams);
      return result.kind === 'refused' ? refused(result.status, result.reason) : relayed(result.response);
    }

    const slot = SLOT_OUTPUT_PATH.exec(rest);
    if (slot && !url.search) {
      const result = await reads.slotOutput(processId, slot[1] ?? '');
      return result.kind === 'refused' ? refused(result.status, result.reason) : relayed(result.response);
    }

    return refused(404, 'not found');
  };

  return async (request: Request): Promise<Response> => {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof NodeUnavailable) {
        logger.warn(error.message, { path: new URL(request.url).pathname });
        return refused(502, 'node is unavailable');
      }
      logger.error('request failed', { path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) });
      return refused(500, 'internal error');
    }
  };
}

export function startServer(options: ServerOptions) {
  return Bun.serve({ port: options.port, maxRequestBodySize: options.maxBodyBytes, fetch: createFetchHandler(options) });
}
