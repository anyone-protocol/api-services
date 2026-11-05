interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  perMinute: number;
  now?: () => number;
  maxKeys?: number;
}

const MINUTE_MS = 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  take(key: string): boolean {
    const now = this.now();
    const capacity = this.options.perMinute;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) / MINUTE_MS) * capacity);
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.prune(now);
    return allowed;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= MINUTE_MS) this.buckets.delete(key);
    }
  }
}
