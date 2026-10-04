/**
 * Rate-limit policies.
 *
 * A policy is just "this many requests per window", and the middleware turns it
 * into a key, an increment, and a 429. Two shapes cover the whole API:
 *
 *   rateLimit       — one bucket, keyed by the caller or by their source IP.
 *   rateLimitLogin  — two buckets in parallel, per-user and per-IP, because a
 *                     credential-stuffing run is one IP against many users while
 *                     a brute-force run is one user from many IPs. Either side
 *                     tripping is enough to refuse the request.
 *
 * The middleware is framework-agnostic on purpose: it takes a request context
 * and a `next` callback, so any router can adapt to it.
 */
import type { CounterStore, WindowCount } from "./counter-store"

export interface RateLimitPolicy {
  /** Requests allowed in one window before the caller is refused. */
  max: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Namespace for counter keys, e.g. "login". */
  prefix: string
}

export interface RequestContext {
  userId?: string | null
  ip?: string | null
}

export class RateLimitError extends Error {
  readonly status = 429
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`)
    this.name = "RateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type Next = () => Promise<unknown>

function secondsUntil(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
}

function overLimit(bucket: WindowCount, max: number): boolean {
  // A reset time in the future means the bucket is live. A stale bucket has
  // already drained and must not count against the caller.
  return bucket.resetAt > Date.now() && bucket.count > max
}

export function rateLimit(store: CounterStore, policy: RateLimitPolicy) {
  return async (context: RequestContext, next: Next): Promise<unknown> => {
    // Authenticated callers get their own bucket; anonymous traffic shares one
    // per source address. The prefix keeps unrelated policies from colliding.
    const key = context.userId
      ? `${policy.prefix}:user:${context.userId}`
      : `${policy.prefix}:ip:${context.ip ?? "unknown"}`

    const bucket = await store.increment(key, policy.windowMs)

    if (overLimit(bucket, policy.max)) {
      throw new RateLimitError(secondsUntil(bucket.resetAt))
    }

    return next()
  }
}

export interface DualRateLimitPolicy {
  perUser: RateLimitPolicy
  perIp: RateLimitPolicy
}

export function rateLimitLogin(store: CounterStore, policy: DualRateLimitPolicy) {
  return async (context: RequestContext, next: Next): Promise<unknown> => {
    // Both increments fire together: the request is measured against the user
    // bucket and the IP bucket in one round trip each, not one after the other.
    const [userBucket, ipBucket] = await Promise.all([
      context.userId
        ? store.increment(
            `${policy.perUser.prefix}:user:${context.userId}`,
            policy.perUser.windowMs,
          )
        : Promise.resolve<WindowCount>({ count: 0, resetAt: 0 }),
      store.increment(
        `${policy.perIp.prefix}:ip:${context.ip ?? "unknown"}`,
        policy.perIp.windowMs,
      ),
    ])

    const userTripped = context.userId
      ? overLimit(userBucket, policy.perUser.max)
      : false
    const ipTripped = overLimit(ipBucket, policy.perIp.max)

    if (userTripped || ipTripped) {
      // Report the wait until *either* bucket frees up; retrying sooner only
      // earns another 429.
      const retryAfter = Math.max(
        userTripped ? secondsUntil(userBucket.resetAt) : 0,
        ipTripped ? secondsUntil(ipBucket.resetAt) : 0,
      )
      throw new RateLimitError(retryAfter)
    }

    return next()
  }
}

export const loginPolicy: DualRateLimitPolicy = {
  perUser: { max: 10, windowMs: 15 * 60_000, prefix: "login" },
  // A shared office NAT must not lock out everyone, so the IP ceiling is the
  // looser of the two while still catching a scripted run.
  perIp: { max: 30, windowMs: 15 * 60_000, prefix: "login" },
}

export const createPostPolicy: RateLimitPolicy = {
  max: 10,
  windowMs: 60 * 60_000,
  prefix: "post_create",
}

export const sendMessagePolicy: RateLimitPolicy = {
  max: 50,
  windowMs: 60 * 60_000,
  prefix: "message_send",
}
