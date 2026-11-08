import type { Logger } from '@anyone-protocol/service-kit';
import type { HyperbeamNode } from './node';

export interface OperatorDirectoryOptions {
  node: HyperbeamNode;
  processId: string;
  refreshMs: number;
  logger: Logger;
}

export class OperatorDirectory {
  private known = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: OperatorDirectoryOptions) {}

  has(address: string): boolean {
    return this.known.has(address);
  }

  add(address: string): void {
    this.known.add(address);
  }

  async refresh(): Promise<void> {
    try {
      const operators = await this.options.node.view<unknown>(this.options.processId, 'operators');
      this.known = new Set(operators && typeof operators === 'object' && !Array.isArray(operators) ? Object.keys(operators) : []);
    } catch (error) {
      this.options.logger.warn('operator list refresh failed, keeping the previous list', { error: error instanceof Error ? error.message : String(error), operators: this.known.size });
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
