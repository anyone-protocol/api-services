export type SampleValue = [timestamp: number, value: string];

interface Series {
  metric: Record<string, string>;
  value: SampleValue;
  values: SampleValue[];
}

export interface QueryResponse {
  status: string;
  data: { resultType: string; result: Series[] };
}

export class VictoriaMetrics {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  query(query: string): Promise<QueryResponse> {
    return this.#get('/api/v1/query', { query });
  }

  queryRange(query: string, start: string, end: string, step: string): Promise<QueryResponse> {
    return this.#get('/api/v1/query_range', { query, start, end, step });
  }

  async #get(path: string, params: Record<string, string>): Promise<QueryResponse> {
    const response = await fetch(`${this.#baseUrl}${path}?${new URLSearchParams(params)}`);
    if (!response.ok) throw new Error(`VictoriaMetrics answered ${response.status}`);
    return (await response.json()) as QueryResponse;
  }
}

export interface RelayMetricLabels {
  cluster: string;
  env: string;
  instance: string;
  job: string;
}

export interface RangeDefaults {
  from: string;
  to: string;
  interval: string;
}

export class RelayMetrics {
  readonly #client: VictoriaMetrics;
  readonly #labels: RelayMetricLabels;
  readonly #defaults: RangeDefaults;

  constructor(client: VictoriaMetrics, labels: RelayMetricLabels, defaults: RangeDefaults) {
    this.#client = client;
    this.#labels = labels;
    this.#defaults = defaults;
  }

  selector(metric: string): string {
    const { cluster, env, instance, job } = this.#labels;
    return `${metric}{cluster="${cluster}", env="${env}", instance="${instance}", job="${job}"}`;
  }

  async latest(metric: string): Promise<Record<string, string>> {
    const response = await this.#client.query(this.selector(metric));
    return Object.fromEntries(response.data.result.map((series) => [series.metric.status, series.value[1]]));
  }

  async range(metric: string, params: URLSearchParams): Promise<Record<string, SampleValue[]>> {
    const from = params.get('from') ?? this.#defaults.from;
    const to = params.get('to') ?? this.#defaults.to;
    const interval = params.get('interval') ?? this.#defaults.interval;
    const response = await this.#client.queryRange(this.selector(metric), from, to, interval);
    return Object.fromEntries(response.data.result.map((series) => [series.metric.status, series.values]));
  }
}
