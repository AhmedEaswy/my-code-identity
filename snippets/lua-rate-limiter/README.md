# Snippet — Lua rate limiter

**A Redis Lua script makes "count, compare, expire" a single atomic step — with a matching in-memory store that keeps limits alive when Redis is not.**

`TypeScript` · `Redis` · `Lua` · atomic fixed-window counters

---

## The problem

A public endpoint is an invitation to be hammered. The obvious limiter — read a
counter, compare it to the cap, write it back, set an expiry if the key is new —
is several round trips, and the gaps between them are races. In a burst, ten
concurrent requests can all read "9 of 10", all conclude they are allowed, and
all pass: the counter lands on 10 while the cap was 10. The expiry is just as
fragile. If the process dies between the increment and the expiry, the key
outlives its window and that caller stays locked out until someone deletes it by
hand.

Two requirements follow. The decision has to come from one indivisible step, and
a bucket that fails to reset must be impossible.

## The mechanism

The whole operation is one `EVAL`, so Redis runs it as a single atomic unit:

```lua
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
```

`INCR` creates or bumps the bucket, `PTTL` reports how much window is left, and
the guard gives a fresh — or TTL-less — key its lifetime. The caller receives the
new count and the reset time in the same reply that changed the state.

The middleware only ever needs that reply, so both backends implement one
interface:

```ts
export interface CounterStore {
  increment(key: string, windowMs: number): Promise<WindowCount>
  close(): Promise<void>
}
```

`createCounterStore` chooses the implementation once, at startup: Redis when
caching is enabled and a client is available, the in-memory map otherwise. When
Redis is the primary it is wrapped, so a runtime failure falls through to memory
instead of failing the request.

## The interesting part

### Atomicity is the whole point

The three commands are only safe together. Split across the network,
`GET`/`INCR`/`EXPIRE` lets two requests read the same value before either
writes, so the bucket undercounts exactly when the system is under the load the
limiter exists for. A crash between `INCR` and `EXPIRE` is worse: the key never
expires, and the caller is permanently over their limit. Inside Lua neither
window exists — Redis executes the script to completion before any other command
can touch the key.

### The fallback is transparent, and honest about it

The in-memory store is deliberately not a pretend-Redis; it is process-local, and
it behaves that way. The middleware code is identical either way — same key,
same `increment`, same 429. Only the blast radius changes. That is the fallback
semantics decision: a cache outage should shrink the *scope* of the limit, not
remove it. A limiter that fails open is worse than none at all, because the
dashboards stay green while the door stands open.

### Why two buckets for login

A single counter keyed by user misses the attacker who sprays one password across
a thousand accounts; a single counter keyed by IP misses the botnet. The login
policy checks both, in parallel, and refuses on either. The IP ceiling is set
looser so a whole office behind one address is not punished for one careless
user.

## Tradeoffs

- **Fixed windows can burst at the boundary.** A caller can spend a full quota at
  the end of one window and another at the start of the next, so the
  instantaneous rate can touch 2×. Sliding-window logs or a token bucket smooth
  this; they cost more memory or more per-request work. For login and write
  endpoints, the fixed window is the right price.
- **The in-memory fallback is per process.** Behind N instances it multiplies the
  effective ceiling by N, and it resets on every deploy. It is a safety net for
  an outage, never the primary limit.
- **The key is the identity.** Keys are namespaced by policy prefix and by user
  or IP, so callers behind a shared address share a bucket. That is intentional
  for abuse, less so for fairness — hence the looser IP cap.
- **A 429 is a contract.** The error carries `retryAfterSeconds`, and the caller
  is told the longest wait across the buckets that tripped, so a retry is a
  decision rather than a guess.

## What this demonstrates

- Pushing a read-modify-write operation into a single Redis round trip with a Lua
  script, instead of hoping a client-side sequence is fast enough.
- Designing an abstraction (`CounterStore`) selected once at startup, so the
  middleware never learns where the count is kept.
- Treating a cache failure as a planned degradation with an explicit, bounded
  fallback rather than an exception to swallow.
- Composing a defence — per-user **and** per-IP — out of small, single-purpose
  policies.

- [`code/counter-store.ts`](code/counter-store.ts) — the Lua script, the Redis and
  in-memory stores, and the resilient wrapper
- [`code/rate-limit.ts`](code/rate-limit.ts) — the per-route and dual user/IP
  login policies
