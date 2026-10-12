import { describe, expect, it } from 'bun:test';
import { createHealthReporter } from './health';

describe('createHealthReporter', () => {
  it('reports the service name and whole seconds since creation', () => {
    let clock = 10_000;
    const health = createHealthReporter('example-service', () => clock);

    clock += 2_500;

    expect(health()).toEqual({ service: 'example-service', status: 'ok', uptimeSeconds: 2 });
  });
});
