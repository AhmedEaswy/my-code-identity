/**
 * Storage router.
 *
 * One policy, many providers. A key is matched against priority-ordered rules;
 * the winning rule names the provider that owns the key and any providers that
 * must hold a replica. Reads may fail over to a fallback or a replica; writes
 * may not, because a write that lands outside its policy is a split brain the
 * next read cannot explain. A per-provider circuit breaker keeps a slow
 * provider from being retried on every request, with a deliberate floor so a
 * fully tripped mesh still gets probed rather than blackholed.
 *
 * The router owns no credentials and imports no vendor SDK. It sees providers
 * only through the contract in ./provider.contract.
 */

import type {
  GetOptions,
  ListOptions,
  ListPage,
  ObjectBody,
  ObjectKey,
  ObjectLocation,
  ObjectProvider,
  ProviderHealth,
  ProviderId,
  PutOptions,
  RoutingFacts,
  RoutingRule,
  StatResult,
} from './provider.contract'

export interface RouterOptions {
  readonly providers: readonly ObjectProvider[]
  readonly rules: readonly RoutingRule[]
  readonly defaultProvider: ProviderId
  /** Read order after the owner fails, before replicas are consulted. */
  readonly fallbacks?: readonly ProviderId[]
  /** Consecutive failures before a provider is tripped out of rotation. */
  readonly breakerThreshold?: number
  readonly breakerCooldownMs?: number
  /** Injectable clock so the breaker is testable without real time. */
  readonly now?: () => number
}

export interface RouterHealth {
  /** The default provider is reachable, so writes have somewhere to land. */
  readonly healthy: boolean
  /** Healthy, but a tracked replica or fallback is down and durability has narrowed. */
  readonly degraded: boolean
  readonly providers: readonly ProviderHealth[]
  readonly tripped: readonly ProviderId[]
}

/** Thrown when every candidate has been tried. Names the key and each attempt. */
export class RouteExhaustedError extends Error {
  readonly key: ObjectKey
  readonly attempted: readonly ProviderId[]
  readonly causes: readonly unknown[]

  constructor(key: ObjectKey, attempted: readonly ProviderId[], causes: readonly unknown[]) {
    super(`No provider could serve '${key}' (tried: ${attempted.join(', ') || 'none'})`)
    this.name = 'RouteExhaustedError'
    this.key = key
    this.attempted = attempted
    this.causes = causes
  }
}

interface RoutePlan {
  readonly owner: ProviderId
  readonly replicas: readonly ProviderId[]
}

interface BreakerState {
  consecutiveFailures: number
  openUntil: number
}

const DEFAULT_BREAKER_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 30_000

export class StorageRouter {
  private readonly providers = new Map<ProviderId, ObjectProvider>()
  private readonly rules: readonly RoutingRule[]
  private readonly defaultProvider: ProviderId
  private readonly fallbacks: readonly ProviderId[]
  private readonly breakerThreshold: number
  private readonly breakerCooldownMs: number
  private readonly now: () => number
  private readonly breakers = new Map<ProviderId, BreakerState>()

  constructor(options: RouterOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.id, provider)
    }
    if (!this.providers.has(options.defaultProvider)) {
      throw new Error(`Default provider '${options.defaultProvider}' is not configured`)
    }

    this.rules = [...options.rules].sort((a, b) => b.priority - a.priority)
    this.defaultProvider = options.defaultProvider
    this.fallbacks = (options.fallbacks ?? []).filter((id) => this.providers.has(id))
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Resolve the policy for a key.
   *
   * A reader knows only the key, so a rule that decides on size or content type
   * can route a write to a provider a later read will never look in. Keep the
   * decision key-derived; content type is a write-time hint, not a routing
   * input. If no rule matches, the default provider owns the key.
   */
  private plan(facts: RoutingFacts): RoutePlan {
    for (const rule of this.rules) {
      if (!rule.matches(facts)) continue
      const owner = this.providers.has(rule.provider) ? rule.provider : this.defaultProvider
      const replicas = (rule.replicateTo ?? []).filter(
        (id) => id !== owner && this.providers.has(id),
      )
      return { owner, replicas }
    }
    return { owner: this.defaultProvider, replicas: [] }
  }

  // --- circuit breaker -----------------------------------------------------

  private isTripped(id: ProviderId): boolean {
    const state = this.breakers.get(id)
    return (
      state !== undefined &&
      state.consecutiveFailures >= this.breakerThreshold &&
      this.now() < state.openUntil
    )
  }

  private noteFailure(id: ProviderId): void {
    const state = this.breakers.get(id) ?? { consecutiveFailures: 0, openUntil: 0 }
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= this.breakerThreshold) {
      state.openUntil = this.now() + this.breakerCooldownMs
    }
    this.breakers.set(id, state)
  }

  private noteSuccess(id: ProviderId): void {
    this.breakers.set(id, { consecutiveFailures: 0, openUntil: 0 })
  }

  /**
   * Candidate order for a read: owner, then declared fallbacks, then replicas.
   * Tripped providers are skipped — unless every candidate is tripped, in which
   * case the full order is returned. A slow provider should degrade a request,
   * never blackhole it.
   */
  private candidateOrder(plan: RoutePlan): readonly ProviderId[] {
    const ordered = dedupe([plan.owner, ...this.fallbacks, ...plan.replicas])
    const reachable = ordered.filter((id) => !this.isTripped(id))
    return reachable.length > 0 ? reachable : ordered
  }

  private *candidates(plan: RoutePlan): Generator<ObjectProvider> {
    for (const id of this.candidateOrder(plan)) {
      yield this.providers.get(id)!
    }
  }

  // --- reads ---------------------------------------------------------------

  async get(key: ObjectKey, options?: GetOptions): Promise<ObjectBody> {
    const plan = this.plan({ key })
    const attempted: ProviderId[] = []
    const causes: unknown[] = []

    for (const provider of this.candidates(plan)) {
      attempted.push(provider.id)
      try {
        const body = await provider.get(key, options)
        this.noteSuccess(provider.id)
        return body
      } catch (error) {
        this.noteFailure(provider.id)
        causes.push(error)
      }
    }

    throw new RouteExhaustedError(key, attempted, causes)
  }

  private async findObject(
    key: ObjectKey,
    plan: RoutePlan,
  ): Promise<{ provider: ObjectProvider; stat: StatResult } | null> {
    for (const provider of this.candidates(plan)) {
      try {
        const stat = await provider.head(key)
        this.noteSuccess(provider.id)
        if (stat !== null) return { provider, stat }
      } catch (error) {
        this.noteFailure(provider.id)
      }
    }
    return null
  }

  async head(key: ObjectKey): Promise<StatResult | null> {
    const found = await this.findObject(key, this.plan({ key }))
    return found?.stat ?? null
  }

  // --- writes --------------------------------------------------------------

  /**
   * Writes never fail over, and that is the point. If the owner is down, a
   * fallback write would put the object somewhere the read path — which follows
   * the same policy — will not look, so the object would exist and be invisible.
   * Failing loudly lets the caller retry against the same policy.
   */
  async put(key: ObjectKey, body: ObjectBody, options?: PutOptions): Promise<ObjectLocation> {
    const plan = this.plan({ key, size: options?.size, contentType: options?.contentType })
    const owner = this.providers.get(plan.owner)!

    // Replication needs the bytes more than once, so a one-shot stream is
    // drained up front. With no replicas it is forwarded untouched.
    const payload = plan.replicas.length > 0 ? await drain(body) : body

    let location: ObjectLocation
    try {
      location = await owner.put(key, payload, options)
      this.noteSuccess(owner.id)
    } catch (error) {
      this.noteFailure(owner.id)
      throw error
    }

    await this.replicate(key, payload, options, plan)
    return location
  }

  private async replicate(
    key: ObjectKey,
    payload: ObjectBody,
    options: PutOptions | undefined,
    plan: RoutePlan,
  ): Promise<void> {
    if (plan.replicas.length === 0) return

    // Best-effort by design: the primary write already committed, so reporting
    // a replica failure as a failed put would be a lie. It is recorded instead,
    // and `health()` surfaces it as degraded.
    await Promise.all(
      plan.replicas.map(async (id) => {
        const replica = this.providers.get(id)!
        try {
          await replica.put(key, payload, options)
          this.noteSuccess(id)
        } catch {
          this.noteFailure(id)
        }
      }),
    )
  }

  /**
   * Delete is a fan-out over every configured provider, not just the owner.
   * Failover reads from replicas — and a replica written under an older policy
   * may still exist — so a single delete that misses one copy lets the next
   * failed-over read resurrect the object. The fan-out is the tombstone.
   */
  async delete(key: ObjectKey): Promise<void> {
    const attempted: ProviderId[] = []
    const causes: unknown[] = []

    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        attempted.push(provider.id)
        try {
          await provider.delete(key)
          this.noteSuccess(provider.id)
        } catch (error) {
          this.noteFailure(provider.id)
          causes.push(error)
        }
      }),
    )

    if (causes.length > 0) throw new RouteExhaustedError(key, attempted, causes)
  }

  // --- copy / move ---------------------------------------------------------

  async copy(from: ObjectKey, to: ObjectKey): Promise<void> {
    const source = this.plan({ key: from })
    const dest = this.plan({ key: to })

    if (source.owner === dest.owner) {
      // Same provider: a server-side copy moves no bytes through the router.
      const provider = this.providers.get(dest.owner)!
      await this.guard(provider, () => provider.copy(from, to))
      return
    }

    // Cross-provider: the bytes must transit the router and land under the
    // destination's policy, which `put` applies (including replication).
    await this.put(to, await this.get(from))
  }

  async move(from: ObjectKey, to: ObjectKey): Promise<void> {
    const source = this.plan({ key: from })
    const dest = this.plan({ key: to })

    if (source.owner === dest.owner) {
      const provider = this.providers.get(dest.owner)!
      await this.guard(provider, () => provider.move(from, to))
      return
    }

    await this.copy(from, to)
    await this.delete(from)
  }

  // --- listing, signing, health -------------------------------------------

  /**
   * Listing is answered by the provider that owns the prefix, never merged
   * across replicas: the same key on two providers is one object, and merging
   * would double-count it. The owner is authoritative.
   */
  async list(prefix: string, options?: ListOptions): Promise<ListPage> {
    const provider = this.providers.get(this.plan({ key: prefix }).owner)!
    return provider.list(prefix, options)
  }

  async presign(key: ObjectKey, method: 'get' | 'put', ttlSeconds: number): Promise<string> {
    const plan = this.plan({ key })

    if (method === 'put') {
      return this.providers.get(plan.owner)!.presign(key, 'put', ttlSeconds)
    }

    // A read URL is only worth signing by a provider that can actually serve
    // the bytes. Probe first, so the client is never handed a dead link.
    const found = await this.findObject(key, plan)
    if (!found) {
      throw new RouteExhaustedError(key, this.candidateOrder(plan), [])
    }
    return found.provider.presign(key, 'get', ttlSeconds)
  }

  async health(): Promise<RouterHealth> {
    const providers = await Promise.all(
      [...this.providers.values()].map(async (provider): Promise<ProviderHealth> => {
        try {
          const report = await provider.health()
          if (report.ok) this.noteSuccess(provider.id)
          return report
        } catch (error) {
          this.noteFailure(provider.id)
          return {
            provider: provider.id,
            ok: false,
            checkedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    const byId = new Map(providers.map((report) => [report.provider, report]))
    const down = (id: ProviderId) => this.isTripped(id) || byId.get(id)?.ok !== true

    // Healthy means the default provider can take writes. Degraded means that
    // is still true, but a tracked fallback or replica is down — reads can
    // still succeed, yet durability has quietly narrowed.
    const healthy = !down(this.defaultProvider)
    const tracked = dedupe([...this.fallbacks, ...this.ruleReplicas()]).filter(
      (id) => id !== this.defaultProvider,
    )

    return {
      healthy,
      degraded: healthy && tracked.some(down),
      providers,
      tripped: [...this.providers.keys()].filter((id) => this.isTripped(id)),
    }
  }

  private ruleReplicas(): readonly ProviderId[] {
    const ids: ProviderId[] = []
    for (const rule of this.rules) {
      if (rule.replicateTo) ids.push(...rule.replicateTo)
    }
    return ids
  }

  private async guard<T>(provider: ObjectProvider, op: () => Promise<T>): Promise<T> {
    try {
      const result = await op()
      this.noteSuccess(provider.id)
      return result
    } catch (error) {
      this.noteFailure(provider.id)
      throw error
    }
  }
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** Buffer a one-shot body exactly once so it can be written to many providers. */
async function drain(body: ObjectBody): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  return Buffer.concat(chunks)
}
