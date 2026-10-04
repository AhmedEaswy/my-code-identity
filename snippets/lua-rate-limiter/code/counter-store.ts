/**
 * Fixed-window counters, in one round trip.
 *
 * The limiter needs exactly one primitive: "increment this bucket, and tell me
 * the new count and when the bucket resets." Redis supplies that through a Lua
 * script; the in-memory store supplies it because Node runs a single JavaScript
 * thread, so no two increments can interleave. Both implement the same
 * interface, so the middleware never has to know which one it is holding.
 */

export interface WindowCount {
  /** Requests seen in the current window, including this one. */
  count: number
  /** Epoch milliseconds at which the current window drains to zero. */
  resetAt: number
}

export interface CounterStore {
  increment(key: string, windowMs: number): Promise<WindowCount>
  close(): Promise<void>
}

/**
 * The whole limiter in one script.
 *
 * `INCR`, `PTTL`, and the conditional `PEXPIRE` run as a single atomic unit:
 * no other command can execute between them. Done from the client as separate
 * calls, two concurrent requests could both observe a missing key and both set
 * the expiry, and a process that died between `INCR` and `PEXPIRE` would leave
 * a key that counts forever and never resets. The TTL guard is a belt-and-
 * braces repair for a key that somehow lost its expiry, so a window can never
 * get stuck open.
 */
export const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`.trim()

/**
 * The slice of a Redis client this file actually uses. Typing it structurally
 * keeps the store testable — any client with `eval` will do — and stops the
 * limiter from reaching for connection details it has no business knowing.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
  disconnect?(): void | Promise<void>
}

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: RedisLike) {}

  async increment(key: string, windowMs: number): Promise<WindowCount> {
    // Drivers return the Lua table as an array; normalise in case one hands
    // back strings rather than numbers.
    const reply = (await this.redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      key,
      String(windowMs),
    )) as [number | string, number | string]

    const count = Number(reply[0])
    const ttlMs = Math.max(Number(reply[1]), 0)

    return { count, resetAt: Date.now() + ttlMs }
  }

  async close(): Promise<void> {
    await this.redis.disconnect?.()
  }
}

/**
 * Process-local fallback.
 *
 * It exists so a missing Redis — local development, or a cache outage — degrades
 * to "limits still apply to this process" rather than "limits are gone". That
 * is the right default: a limiter that fails open under load protects nothing.
 *
 * The catch is that the count lives in one process. Behind N instances the
 * effective ceiling becomes N × max, so this is a safety net, not a
 * horizontally-consistent limit.
 */
export class MemoryCounterStore implements CounterStore {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>()
  private readonly sweeper: ReturnType<typeof setInterval> | null

  constructor(sweepIntervalMs = 60_000) {
    // Lazy expiry already rejects stale reads; the sweeper only stops a burst of
    // one-shot keys from growing the map without bound.
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs)
    // Do not keep a server process alive just to prune counters.
    this.sweeper.unref?.()
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key)
    }
  }

  async increment(key: string, windowMs: number): Promise<WindowCount> {
    const now = Date.now()
    const existing = this.buckets.get(key)

    if (!existing || existing.expiresAt <= now) {
      const fresh = { count: 1, expiresAt: now + windowMs }
      this.buckets.set(key, fresh)
      return { count: 1, resetAt: fresh.expiresAt }
    }

    // Single-threaded: nothing can interleave between this read and write.
    existing.count += 1
    return { count: existing.count, resetAt: existing.expiresAt }
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.buckets.clear()
  }
}

/**
 * Primary with a transparent fallback.
 *
 * Every increment tries Redis first. If the call throws — a dropped connection,
 * a failover, an out-of-memory — the same increment is applied to the
 * process-local store and the request proceeds. The failure is reported through
 * `onFallback` instead of being swallowed, because "we are no longer limiting
 * globally" is an operational event, not an implementation detail.
 */
export class ResilientCounterStore implements CounterStore {
  constructor(
    private readonly primary: CounterStore,
    private readonly fallback: CounterStore,
    private readonly onFallback: (error: unknown) => void = () => {},
  ) {}

  async increment(key: string, windowMs: number): Promise<WindowCount> {
    try {
      return await this.primary.increment(key, windowMs)
    } catch (error) {
      this.onFallback(error)
      return this.fallback.increment(key, windowMs)
    }
  }

  async close(): Promise<void> {
    await this.primary.close()
    await this.fallback.close()
  }
}

export interface CounterStoreConfig {
  /** False skips Redis entirely and hands back the in-memory store. */
  redisEnabled: boolean
  redis?: RedisLike | null
  onFallback?: (error: unknown) => void
  sweepIntervalMs?: number
}

export function createCounterStore(config: CounterStoreConfig): CounterStore {
  if (!config.redisEnabled || !config.redis) {
    return new MemoryCounterStore(config.sweepIntervalMs)
  }

  return new ResilientCounterStore(
    new RedisCounterStore(config.redis),
    new MemoryCounterStore(config.sweepIntervalMs),
    config.onFallback,
  )
}
