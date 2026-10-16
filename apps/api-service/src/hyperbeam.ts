export class ViewReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ReadViewOptions {
  attempts?: number;
  retryDelayMs?: number;
}

export function viewUrl(nodeUrl: string, processId: string, view: string): string {
  return `${nodeUrl.replace(/\/+$/, '')}/${processId}~process@1.0/as/${view}`;
}

export async function readView<T>(nodeUrl: string, processId: string, view: string, { attempts = 3, retryDelayMs = 2_000 }: ReadViewOptions = {}): Promise<T> {
  const url = viewUrl(nodeUrl, processId, view);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new ViewReadError(`node answered ${response.status} reading view ${view}`, response.status >= 500);
      const body = await response.text();
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new ViewReadError(`view ${view} did not return JSON: ${body.slice(0, 120)}`, false);
      }
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ViewReadError) || error.retryable;
      if (!retryable || attempt === attempts - 1) break;
      await Bun.sleep(retryDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
