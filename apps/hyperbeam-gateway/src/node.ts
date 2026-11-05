export interface NodeResponse {
  status: number;
  body: string;
  contentType: string | null;
  slot: string | null;
  location: string | null;
}

export class NodeUnavailable extends Error {}

export interface HyperbeamNodeOptions {
  url: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

export class HyperbeamNode {
  private readonly base: string;

  constructor(private readonly options: HyperbeamNodeOptions) {
    this.base = options.url.replace(/\/+$/, '');
  }

  processUrl(processId: string, path: string): string {
    return `${this.base}/${processId}~process@1.0/${path}`;
  }

  async get(processId: string, path: string): Promise<NodeResponse> {
    return this.send(this.processUrl(processId, path), { method: 'GET' }, this.options.readTimeoutMs);
  }

  async push(processId: string, item: Uint8Array): Promise<NodeResponse> {
    return this.send(
      this.processUrl(processId, 'push'),
      { method: 'POST', headers: { 'content-type': 'application/ans104', 'codec-device': 'ans104@1.0' }, body: item },
      this.options.writeTimeoutMs,
    );
  }

  async view<T>(processId: string, view: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const response = await this.get(processId, `as/${view}${query ? `?${query}` : ''}`);
    if (response.status !== 200) throw new NodeUnavailable(`node answered ${response.status} reading view ${view}`);
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new NodeUnavailable(`view ${view} did not return JSON`);
    }
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<NodeResponse> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new NodeUnavailable(`node request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type'),
      slot: response.headers.get('slot'),
      location: response.headers.get('location'),
    };
  }
}
