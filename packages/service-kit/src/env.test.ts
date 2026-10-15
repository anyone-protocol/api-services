import { describe, expect, it } from 'bun:test';
import { commonEnv, env, parseEnv } from './env';
import { Secret } from './secret';

describe('parseEnv', () => {
  it('parses each variable with its parser', () => {
    const config = parseEnv(
      {
        NAME: env.string(),
        PORT: env.integer(),
        UPSTREAM_URL: env.url(),
        MODE: env.oneOf(['fast', 'safe']),
      },
      { NAME: 'example', PORT: '8080', UPSTREAM_URL: 'http://10.0.0.1:9000', MODE: 'safe' },
    );

    expect(config).toEqual({ NAME: 'example', PORT: 8080, UPSTREAM_URL: 'http://10.0.0.1:9000', MODE: 'safe' });
  });

  it('uses the default when a variable is unset or blank', () => {
    const config = parseEnv({ PORT: env.integer({ default: 3000 }), NAME: env.string({ default: 'example' }) }, { NAME: '  ' });

    expect(config).toEqual({ PORT: 3000, NAME: 'example' });
  });

  it('leaves an unset optional variable undefined', () => {
    expect(parseEnv({ TOKEN: env.string({ optional: true }) }, {})).toEqual({ TOKEN: undefined });
  });

  it('reports every invalid variable at once without echoing values', () => {
    const parse = () =>
      parseEnv(
        { REQUIRED: env.string(), PORT: env.integer(), UPSTREAM_URL: env.url(), MODE: env.oneOf(['fast', 'safe']) },
        { PORT: '80.5', UPSTREAM_URL: 'secret-value', MODE: 'slow' },
      );

    expect(parse).toThrow(
      'Invalid environment: REQUIRED is required; PORT must be an integer; UPSTREAM_URL must be an absolute URL; MODE must be one of fast, safe',
    );
  });
});

describe('env.durationMs', () => {
  it('reads a number with a unit as milliseconds', () => {
    const config = parseEnv(
      { A: env.durationMs(), B: env.durationMs(), C: env.durationMs(), D: env.durationMs(), E: env.durationMs() },
      { A: '500ms', B: '30s', C: '15m', D: '12h', E: '3d' },
    );

    expect(config).toEqual({ A: 500, B: 30_000, C: 900_000, D: 43_200_000, E: 259_200_000 });
  });

  it('rejects a duration without a known unit', () => {
    expect(() => parseEnv({ INTERVAL: env.durationMs() }, { INTERVAL: '12' })).toThrow('INTERVAL must be a duration');
    expect(() => parseEnv({ INTERVAL: env.durationMs() }, { INTERVAL: '1.5h' })).toThrow('INTERVAL must be a duration');
  });
});

describe('env.secret', () => {
  it('wraps the parsed value so it prints as redacted', () => {
    const config = parseEnv({ DB_PASS: env.secret(env.string()) }, { DB_PASS: 'env-secret-value' });

    expect(config.DB_PASS).toBeInstanceOf(Secret);
    expect(config.DB_PASS.reveal()).toBe('env-secret-value');
    expect(JSON.stringify(config)).toBe('{"DB_PASS":"[redacted]"}');
  });

  it('leaves an unset optional secret undefined', () => {
    expect(parseEnv({ TOKEN: env.secret(env.string({ optional: true })) }, {})).toEqual({ TOKEN: undefined });
  });

  it('reports a missing or invalid secret by name only', () => {
    expect(() => parseEnv({ DB_PASS: env.secret(env.string()) }, {})).toThrow('Invalid environment: DB_PASS is required');
    expect(() => parseEnv({ DB_URI: env.secret(env.url()) }, { DB_URI: 'not a url with p4ssword' })).toThrow(
      'Invalid environment: DB_URI must be an absolute URL',
    );
  });
});

describe('commonEnv', () => {
  it('defaults to port 3000 and info logging', () => {
    expect(parseEnv(commonEnv, {})).toEqual({ PORT: 3000, LOG_LEVEL: 'info' });
  });
});
