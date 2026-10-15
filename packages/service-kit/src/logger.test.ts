import { describe, expect, it } from 'bun:test';
import { createLogger, type LoggerOptions } from './logger';
import { Secret } from './secret';

function capture(options: Omit<LoggerOptions, 'service' | 'write'> = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'example-service',
    now: () => Date.UTC(2030, 0, 2, 3, 4, 5),
    write: (line) => lines.push(JSON.parse(line)),
    ...options,
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line with the time, level, message, service and fields', () => {
    const { logger, lines } = capture();

    logger.info('Listening', { port: 3000 });

    expect(lines).toEqual([
      { timestamp: '2030-01-02T03:04:05.000Z', level: 'info', message: 'Listening', service: 'example-service', port: 3000 },
    ]);
  });

  it('drops entries below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('writes errors with their name, message and stack', () => {
    const { logger, lines } = capture();

    logger.error('Request failed', { error: new TypeError('bad input') });

    expect(lines[0]?.error).toMatchObject({ name: 'TypeError', message: 'bad input', stack: expect.stringContaining('bad input') });
  });

  it('redacts secrets in fields and in error messages', () => {
    const { logger, lines } = capture();
    const password = new Secret('logged-secret-value');

    logger.info('Config', { password });
    logger.error('Connect failed', { error: new Error(`auth failed for ${password.reveal()}`) });

    expect(lines[0]?.password).toBe('[redacted]');
    expect(JSON.stringify(lines[1])).not.toContain('logged-secret-value');
    expect(lines[1]?.error).toMatchObject({ message: 'auth failed for [redacted]' });
  });

  it('adds the fields of a child logger to every entry it writes', () => {
    const { logger, lines } = capture();

    logger.child({ component: 'cache' }).info('Refreshed', { entries: 2 });

    expect(lines[0]).toMatchObject({ service: 'example-service', component: 'cache', entries: 2 });
  });
});
