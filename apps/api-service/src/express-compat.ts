import { createHash } from 'node:crypto';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const CORS_HEADERS = { 'access-control-allow-origin': '*' };
const CORS_ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';
const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;
const JSON_BODY_LIMIT_BYTES = 100 * 1024;
const FIRST_NON_WHITESPACE = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/;
const HTML_ESCAPES: Record<string, string> = { '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' };

function weakEtag(body: string): string {
  const bytes = Buffer.from(body, 'utf8');
  const hash = createHash('sha1').update(bytes).digest('base64').substring(0, 27);
  return `W/"${bytes.length.toString(16)}-${hash}"`;
}

function isFresh(request: Request, status: number, etag: string): boolean {
  const { headers } = request;
  const noneMatch = headers.get('if-none-match');
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (status < 200 || status >= 300) return false;
  if (!noneMatch || headers.has('if-modified-since')) return false;
  if (NO_CACHE.test(headers.get('cache-control') ?? '')) return false;
  if (noneMatch === '*') return true;
  return noneMatch
    .split(/[ ,]+/)
    .filter(Boolean)
    .some((tag) => tag === etag || tag === `W/${etag}` || `W/${tag}` === etag);
}

function send(request: Request, status: number, body: string, contentType: string): Response {
  const etag = weakEtag(body);
  if (isFresh(request, status, etag)) {
    return new Response(null, { status: 304, headers: { ...CORS_HEADERS, etag } });
  }
  return new Response(body, { status, headers: { ...CORS_HEADERS, 'content-type': contentType, etag } });
}

export function json(request: Request, body: unknown, status = 200): Response {
  return send(request, status, JSON.stringify(body), JSON_CONTENT_TYPE);
}

export function html(request: Request, body: string, status = 200): Response {
  return send(request, status, body, HTML_CONTENT_TYPE);
}

function escapeHtml(text: string): string {
  return text.replace(/["&'<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function errorPage(status: number, message: string, { cors = true } = {}): Response {
  const body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>${escapeHtml(message)}</pre>\n</body>\n</html>\n`;
  return new Response(body, { status, headers: { ...(cors && CORS_HEADERS), 'content-type': HTML_CONTENT_TYPE } });
}

export function notFound(request: Request): Response {
  return errorPage(404, `Cannot ${request.method} ${new URL(request.url).pathname}`);
}

export function preflight(request: Request): Response {
  const requestedHeaders = request.headers.get('access-control-request-headers');
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-allow-methods': CORS_ALLOWED_METHODS,
      vary: 'Access-Control-Request-Headers',
      ...(requestedHeaders && { 'access-control-allow-headers': requestedHeaders }),
      'content-length': '0',
    },
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return {};

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > JSON_BODY_LIMIT_BYTES) return errorPage(413, 'Payload Too Large', { cors: false });
  if (bytes.byteLength === 0) return {};

  const text = new TextDecoder().decode(bytes);
  const first = FIRST_NON_WHITESPACE.exec(text)?.[1];
  if (first !== '{' && first !== '[') return errorPage(400, 'Bad Request', { cors: false });
  try {
    return JSON.parse(text);
  } catch {
    return errorPage(400, 'Bad Request', { cors: false });
  }
}

export function relayedText(request: Request, text: string): Response {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return json(request, parsed);
  } catch {}
  return html(request, text);
}
