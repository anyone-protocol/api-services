import { LOG_LEVELS } from './logger';
import { Secret } from './secret';

export type EnvParser<T> = (raw: string | undefined) => T;

export type Environment = Record<string, string | undefined>;

export type ParsedEnv<Schema extends Record<string, EnvParser<unknown>>> = { [Name in keyof Schema]: ReturnType<Schema[Name]> };

interface VariableOptions<T> {
  default?: T;
  optional?: boolean;
}

interface DefineVariable<T> {
  (): EnvParser<T>;
  (options: { default: T }): EnvParser<T>;
  (options: { optional: true }): EnvParser<T | undefined>;
}

interface DefineOneOf {
  <const Value extends string>(values: readonly Value[]): EnvParser<Value>;
  <const Value extends string>(values: readonly Value[], options: { default: NoInfer<Value> }): EnvParser<Value>;
  <const Value extends string>(values: readonly Value[], options: { optional: true }): EnvParser<Value | undefined>;
}

class InvalidVariable extends Error {}

function parser<T>(parse: (raw: string) => T, options: VariableOptions<T> = {}): EnvParser<T | undefined> {
  return (raw) => {
    const value = raw?.trim();
    if (value) return parse(value);
    if (options.default !== undefined) return options.default;
    if (options.optional) return undefined;
    throw new InvalidVariable('is required');
  };
}

function variable<T>(parse: (raw: string) => T): DefineVariable<T> {
  return ((options?: VariableOptions<T>) => parser(parse, options)) as DefineVariable<T>;
}

function parseInteger(raw: string): number {
  if (!/^-?\d+$/.test(raw)) throw new InvalidVariable('must be an integer');
  return Number(raw);
}

const DURATION_UNITS_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
  if (!match) throw new InvalidVariable('must be a duration such as 500ms, 30s, 15m, 12h or 3d');
  return Number(match[1]) * (DURATION_UNITS_MS[match[2] ?? ''] ?? 0);
}

function parseUrl(raw: string): string {
  if (!URL.canParse(raw)) throw new InvalidVariable('must be an absolute URL');
  return raw;
}

function oneOf(values: readonly string[], options?: VariableOptions<string>): EnvParser<string | undefined> {
  return parser((raw) => {
    if (!values.includes(raw)) throw new InvalidVariable(`must be one of ${values.join(', ')}`);
    return raw;
  }, options);
}

function secret<T>(parse: EnvParser<T>): EnvParser<Secret<NonNullable<T>> | Extract<T, undefined>> {
  return (raw) => {
    const value = parse(raw);
    return (value === undefined ? undefined : new Secret(value)) as Secret<NonNullable<T>> | Extract<T, undefined>;
  };
}

export const env = {
  string: variable((raw) => raw),
  integer: variable(parseInteger),
  durationMs: variable(parseDuration),
  url: variable(parseUrl),
  oneOf: oneOf as DefineOneOf,
  secret,
};

export const commonEnv = {
  PORT: env.integer({ default: 3000 }),
  LOG_LEVEL: env.oneOf(LOG_LEVELS, { default: 'info' }),
};

export function parseEnv<Schema extends Record<string, EnvParser<unknown>>>(schema: Schema, source: Environment = process.env): ParsedEnv<Schema> {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, parse] of Object.entries(schema)) {
    try {
      values[name] = parse(source[name]);
    } catch (error) {
      if (!(error instanceof InvalidVariable)) throw error;
      problems.push(`${name} ${error.message}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  return values as ParsedEnv<Schema>;
}
