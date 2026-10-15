import { describe, expect, it } from 'bun:test';
import { createLogger } from './logger';
import { runShutdown } from './shutdown';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: 'example-service', write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

describe('runShutdown', () => {
  it('runs every task in order and reports a clean shutdown', async () => {
    const { logger } = capture();
    const order: string[] = [];

    const clean = await runShutdown(
      [
        ['http server', async () => order.push('http server')],
        ['database', () => order.push('database')],
      ],
      { logger },
    );

    expect(clean).toBe(true);
    expect(order).toEqual(['http server', 'database']);
  });

  it('keeps going after a task fails and reports the shutdown as unclean', async () => {
    const { logger, lines } = capture();
    let databaseClosed = false;

    const clean = await runShutdown(
      [
        [
          'http server',
          () => {
            throw new Error('already stopped');
          },
        ],
        ['database', () => (databaseClosed = true)],
      ],
      { logger },
    );

    expect(clean).toBe(false);
    expect(databaseClosed).toBe(true);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', task: 'http server' }));
  });

  it('gives up when the tasks outlast the timeout', async () => {
    const { logger, lines } = capture();

    const clean = await runShutdown([['http server', () => new Promise(() => {})]], { logger, timeoutMs: 20 });

    expect(clean).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ message: 'Shutdown timed out', timeoutMs: 20 }));
  });
});
