import type { Logger } from './logger';

export type ShutdownTask = readonly [name: string, run: () => unknown];

export interface ShutdownOptions {
  logger: Logger;
  timeoutMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function runTasks(tasks: readonly ShutdownTask[], logger: Logger): Promise<boolean> {
  let clean = true;
  for (const [task, run] of tasks) {
    try {
      await run();
      logger.info('Shutdown task finished', { task });
    } catch (error) {
      clean = false;
      logger.error('Shutdown task failed', { task, error });
    }
  }
  return clean;
}

export async function runShutdown(tasks: readonly ShutdownTask[], { logger, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS }: ShutdownOptions): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      logger.error('Shutdown timed out', { timeoutMs });
      resolve(false);
    }, timeoutMs);
  });

  try {
    return await Promise.race([runTasks(tasks, logger), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function handleUncaughtErrors(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason });
    process.exit(1);
  });
}

export function handleShutdownSignals(tasks: readonly ShutdownTask[], options: ShutdownOptions): void {
  let stopping = false;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, async () => {
      if (stopping) {
        options.logger.warn('Second shutdown signal, exiting now', { signal });
        process.exit(1);
      }
      stopping = true;
      options.logger.info('Shutting down', { signal });
      process.exit((await runShutdown(tasks, options)) ? 0 : 1);
    });
  }
}
