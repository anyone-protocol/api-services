import { describe, expect, it } from 'bun:test';
import { createHealthReporter, healthResponse } from './health';
import { Secret } from './secret';

describe('createHealthReporter', () => {
  it('reports the service name and whole seconds since creation', () => {
    let clock = 10_000;
    const health = createHealthReporter('example-service', { now: () => clock });

    clock += 2_500;

    expect(health()).toEqual({ service: 'example-service', status: 'ok', uptimeSeconds: 2, checks: {} });
  });

  it('takes the worst status of its checks', () => {
    const health = createHealthReporter('example-service', {
      checks: {
        database: () => ({ status: 'ok' }),
        cache: () => ({ status: 'degraded', entries: 3 }),
      },
    });

    expect(health()).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'ok' }, cache: { status: 'degraded', entries: 3 } },
    });
  });

  it('reports a check that throws as down', () => {
    const health = createHealthReporter('example-service', {
      checks: {
        database: () => {
          throw new Error('not connected');
        },
      },
    });

    expect(health()).toMatchObject({ status: 'down', checks: { database: { status: 'down', error: 'not connected' } } });
  });
});

describe('healthResponse', () => {
  const report = { service: 'example-service', uptimeSeconds: 0, checks: {} };

  it('answers 200 while the service is ok or degraded', () => {
    expect(healthResponse({ ...report, status: 'ok' }).status).toBe(200);
    expect(healthResponse({ ...report, status: 'degraded' }).status).toBe(200);
  });

  it('redacts secrets in check details', async () => {
    const key = new Secret('health-secret-value');
    const health = createHealthReporter('example-service', {
      checks: { upstream: () => ({ status: 'degraded', lastError: `refused ${key.reveal()}` }) },
    });

    const response = healthResponse(health());

    expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(await response.json()).toMatchObject({ checks: { upstream: { lastError: 'refused [redacted]' } } });
  });

  it('answers 503 when the service is down', async () => {
    const response = healthResponse({ ...report, status: 'down' });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'down' });
  });
});
