import type { Logger } from '@anyone-protocol/service-kit';
import { readView, type ReadViewOptions } from './hyperbeam';

export interface OperatorRegistryOptions {
  nodeUrl: string;
  processId: string;
  cacheTtlMs: number;
  logger: Logger;
  read?: ReadViewOptions;
  now?: () => number;
}

export class OperatorRegistry {
  readonly #options: OperatorRegistryOptions;
  readonly #now: () => number;
  #cached: string[] | undefined;
  #cachedAt = 0;

  constructor(options: OperatorRegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async operators(): Promise<string[]> {
    const now = this.#now();
    if (!this.#cached || now - this.#cachedAt >= this.#options.cacheTtlMs) {
      await this.#refresh(now);
    }
    if (!this.#cached) {
      this.#options.logger.error('Operator registry state is not available');
    }
    return this.#cached ?? [];
  }

  async #refresh(now: number): Promise<void> {
    const { nodeUrl, processId, logger, read } = this.#options;
    try {
      const operators = await readView<Record<string, boolean>>(nodeUrl, processId, 'operators', read);
      this.#cached = Object.keys(operators);
      this.#cachedAt = now;
      logger.debug('Operator registry state fetched', { operators: this.#cached.length });
    } catch (error) {
      logger.error('Failed to read operator registry state', { processId, error });
    }
  }
}
