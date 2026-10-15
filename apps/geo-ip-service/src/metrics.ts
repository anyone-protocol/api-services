export type Labels = Record<string, string>;

export interface Sample {
  labels?: Labels;
  value: number;
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelSet(labels: Labels = {}): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabelValue(value)}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}

export function metricFamily(name: string, type: 'counter' | 'gauge', help: string, samples: Sample[]): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples.map((sample) => `${name}${labelSet(sample.labels)} ${sample.value}`)].join('\n');
}

export class Counter {
  readonly #samples = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelSet(labels);
    const sample = this.#samples.get(key) ?? { labels, value: 0 };
    sample.value += amount;
    this.#samples.set(key, sample);
  }

  render(): string {
    return metricFamily(this.name, 'counter', this.help, [...this.#samples.values()]);
  }
}

export class Summary {
  #sum = 0;
  #count = 0;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(value: number): void {
    this.#sum += value;
    this.#count += 1;
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`, `${this.name}_sum ${this.#sum}`, `${this.name}_count ${this.#count}`].join('\n');
  }
}
