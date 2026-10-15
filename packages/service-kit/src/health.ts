export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: HealthStatus;
  [detail: string]: unknown;
}

export type HealthCheck = () => CheckResult;

export interface HealthReport {
  service: string;
  status: HealthStatus;
  uptimeSeconds: number;
  checks: Record<string, CheckResult>;
}

export interface HealthReporterOptions {
  checks?: Record<string, HealthCheck>;
  now?: () => number;
}

const SEVERITY: readonly HealthStatus[] = ['ok', 'degraded', 'down'];

function runCheck(check: HealthCheck): CheckResult {
  try {
    return check();
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  }
}

function worst(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce((current, status) => (SEVERITY.indexOf(status) > SEVERITY.indexOf(current) ? status : current), 'ok');
}

export function createHealthReporter(service: string, { checks = {}, now = Date.now }: HealthReporterOptions = {}): () => HealthReport {
  const startedAt = now();
  return () => {
    const results = Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, runCheck(check)]));
    return {
      service,
      status: worst(Object.values(results).map((result) => result.status)),
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      checks: results,
    };
  };
}

export function healthResponse(report: HealthReport): Response {
  return Response.json(report, { status: report.status === 'down' ? 503 : 200 });
}
