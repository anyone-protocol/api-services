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

describe('handleUncaughtErrors', () => {
  async function crash(failure: string) {
    const serviceKit = `${import.meta.dir}/index.ts`;
    const script = `
      import { createLogger, handleUncaughtErrors, Secret } from ${JSON.stringify(serviceKit)};
      const key = new Secret('crash-secret-value');
      handleUncaughtErrors(createLogger({ service: 'example-service' }));
      ${failure}
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { lines: stdout.trim().split('\n').map((line) => JSON.parse(line)), stderr, exitCode };
  }

  it.each([
    ['an uncaught exception', 'setTimeout(() => { throw new Error("rejected " + key.reveal()); });', 'Uncaught exception'],
    ['an unhandled rejection', 'Promise.reject(new Error("rejected " + key.reveal()));', 'Unhandled promise rejection'],
  ])('logs %s through the logger with secrets redacted and exits 1', async (_, failure, message) => {
    const { lines, stderr, exitCode } = await crash(failure);

    expect(exitCode).toBe(1);
    expect(stderr).toBe('');
    expect(lines).toEqual([expect.objectContaining({ level: 'error', message, error: expect.objectContaining({ message: 'rejected [redacted]' }) })]);
  });
});
