export interface HealthReport {
  service: string;
  status: 'ok';
  uptimeSeconds: number;
}

export function createHealthReporter(service: string, now: () => number = Date.now): () => HealthReport {
  const startedAt = now();
  return () => ({
    service,
    status: 'ok',
    uptimeSeconds: Math.floor((now() - startedAt) / 1000),
  });
}
