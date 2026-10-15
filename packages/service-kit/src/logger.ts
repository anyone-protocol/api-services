export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => number;
}

function serializable(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

function buildLogger(bound: LogFields, threshold: number, write: (line: string) => void, now: () => number): Logger {
  const at = (level: LogLevel) => (message: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const entries = Object.entries({ ...bound, ...fields }).map(([key, value]) => [key, serializable(value)]);
    write(JSON.stringify({ timestamp: new Date(now()).toISOString(), level, message, ...Object.fromEntries(entries) }));
  };

  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (fields) => buildLogger({ ...bound, ...fields }, threshold, write, now),
  };
}

export function createLogger({ service, level = 'info', write = console.log, now = Date.now }: LoggerOptions): Logger {
  return buildLogger({ service }, LOG_LEVELS.indexOf(level), write, now);
}
