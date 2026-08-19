/**
 * A per-key fixed-budget rate limiter, in memory.
 *
 * `POST /api/signup` is an unauthenticated public write on a page that is about
 * to be posted to Reddit. It will be found by a bot, and without a limit the
 * first one to find it can fill the table overnight.
 *
 * Proportionate on purpose. Per-instance memory, not Redis: the failure mode of
 * this being approximate is that someone behind a shared NAT waits a minute, or
 * that an attacker spread across two instances gets twice the budget. The
 * failure mode of an unlimited endpoint is a database full of garbage. Nothing
 * here is a security boundary — the admin lock is, and it is a separate thing.
 *
 * Pure and clock-injectable so the tests can prove the window without sleeping.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests left in the current window after this decision. */
  readonly remaining: number;
  /** Whole seconds until the window resets. For a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Records an attempt for `key` and says whether it is allowed. */
  check(key: string, now?: number): RateLimitDecision;
  /** Drops the record for one key. */
  forget(key: string): void;
  /** Number of keys currently tracked. Exposed for the memory-bound test. */
  size(): number;
}

export interface RateLimiterOptions {
  /** Attempts allowed per key per window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Hard cap on tracked keys, so a spray of forged IPs cannot grow the map
   * without bound. Oldest-first eviction: the entries closest to expiring go.
   */
  readonly maxKeys?: number;
}

interface Bucket {
  /** Timestamps of the attempts inside the window, oldest first. */
  hits: number[];
}

const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, Bucket>();

  /** Sliding window: drops the hits that have aged out of `key`'s bucket. */
  function prune(bucket: Bucket, now: number): void {
    const cutoff = now - windowMs;
    while (bucket.hits.length > 0 && (bucket.hits[0] ?? 0) <= cutoff) bucket.hits.shift();
  }

  /*
   * Sweeps expired buckets, then — if still over the cap — evicts whichever keys
   * are closest to expiring. Runs only when the map is at the cap, so the common
   * path stays a map lookup.
   */
  function evict(now: number): void {
    for (const [key, bucket] of buckets) {
      prune(bucket, now);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
    if (buckets.size < maxKeys) return;
    const byAge = [...buckets.entries()]
      .sort((a, b) => (a[1].hits[0] ?? 0) - (b[1].hits[0] ?? 0));
    for (const [key] of byAge.slice(0, Math.max(1, Math.ceil(maxKeys / 10)))) {
      buckets.delete(key);
    }
  }

  return {
    check(key, now = Date.now()) {
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        if (buckets.size >= maxKeys) evict(now);
        bucket = { hits: [] };
        buckets.set(key, bucket);
      }
      prune(bucket, now);

      const oldest = bucket.hits[0];
      if (bucket.hits.length >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(((oldest ?? now) + windowMs - now) / 1000),
          ),
        };
      }

      bucket.hits.push(now);
      return {
        allowed: true,
        remaining: limit - bucket.hits.length,
        retryAfterSeconds: 0,
      };
    },

    forget(key) {
      buckets.delete(key);
    },

    size() {
      return buckets.size;
    },
  };
}

/**
 * Best-effort client identity for rate limiting.
 *
 * Behind Railway's proxy the socket address is the proxy, so the forwarded
 * headers are all there is. They are forgeable, which is exactly why this value
 * is used for nothing but a rate-limit bucket — never for authentication, and
 * never stored.
 *
 * Returns the LEFTMOST entry of `x-forwarded-for` (the client as the first proxy
 * saw it). Callers that get `unknown` share one bucket, which is deliberately the
 * strictest outcome rather than the most permissive.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first.slice(0, 64);
  }
  const real = headers.get('x-real-ip')?.trim();
  if (real !== undefined && real !== '') return real.slice(0, 64);
  return 'unknown';
}
