import { describe, expect, it } from 'bun:test';
import { commonEnv, env, parseEnv } from './env';

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

describe('commonEnv', () => {
  it('defaults to port 3000 and info logging', () => {
    expect(parseEnv(commonEnv, {})).toEqual({ PORT: 3000, LOG_LEVEL: 'info' });
  });
});
