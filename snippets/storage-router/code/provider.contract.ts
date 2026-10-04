/**
 * The provider contract.
 *
 * A provider is anything that can hold bytes under a string key: a local disk,
 * a remote object store, a cache tier sitting in front of either. The router
 * never imports a vendor SDK or sees an endpoint, a bucket, or a signing scheme
 * — only this shape. That is what lets one routing policy span a fast tier and
 * a cheap archive tier, or two regions, without either side knowing about the
 * other.
 *
 * Every method is key-addressed, never URL-addressed. Whatever path a provider
 * builds internally is its own private business and never leaks upward, so a
 * provider can be replaced without touching the policy.
 */

import type { Readable } from 'stream'

/** Opaque to the router. A configured name such as `edge`, `warm`, `archive`. */
export type ProviderId = string

/** Opaque to the router; only rules and providers interpret its parts. */
export type ObjectKey = string

/** Bytes entering the system, as a buffer or a one-shot stream. */
export type ObjectBody = Buffer | Readable

/** Cheap facts available before an object exists — used by matching rules. */
export interface ObjectMeta {
  readonly size?: number
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export type PutOptions = ObjectMeta

export interface GetOptions {
  /** Inclusive byte range. A provider may ignore it if it cannot seek. */
  readonly range?: { readonly start: number; readonly end: number }
}

export interface StatResult {
  readonly key: ObjectKey
  readonly size: number
  readonly etag?: string
  readonly contentType?: string
  readonly lastModified: Date
  readonly metadata?: Readonly<Record<string, string>>
}

export interface ListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface ListPage {
  readonly entries: readonly StatResult[]
  readonly cursor?: string
  readonly truncated: boolean
}

export interface ObjectLocation {
  readonly provider: ProviderId
  readonly key: ObjectKey
  /** A stable public URL when the provider can offer one. Optional by design. */
  readonly url?: string
}

export interface ProviderHealth {
  readonly provider: ProviderId
  readonly ok: boolean
  readonly latencyMs?: number
  readonly checkedAt: Date
  readonly error?: string
}

export interface ObjectProvider {
  readonly id: ProviderId

  put(key: ObjectKey, body: ObjectBody, options?: PutOptions): Promise<ObjectLocation>
  get(key: ObjectKey, options?: GetOptions): Promise<ObjectBody>

  /** Returns `null` for absent rather than throwing: absence is not a fault. */
  head(key: ObjectKey): Promise<StatResult | null>

  /** Must be idempotent: deleting an absent key is a success, not an error. */
  delete(key: ObjectKey): Promise<void>

  list(prefix: string, options?: ListOptions): Promise<ListPage>
  copy(from: ObjectKey, to: ObjectKey): Promise<void>
  move(from: ObjectKey, to: ObjectKey): Promise<void>

  /**
   * A time-limited URL a client can use directly, bypassing the router. The
   * provider that signs it must be the one that actually holds the object, or
   * the link resolves to nothing.
   */
  presign(key: ObjectKey, method: 'get' | 'put', ttlSeconds: number): Promise<string>

  health(): Promise<ProviderHealth>
}

/** What a rule may inspect. Deliberately small: cheap, pre-read signals only. */
export interface RoutingFacts {
  readonly key: ObjectKey
  readonly size?: number
  readonly contentType?: string
}

export interface RoutingRule {
  readonly name: string
  /** Higher wins; ties break by declaration order for a stable winner. */
  readonly priority: number
  readonly matches: (facts: RoutingFacts) => boolean
  /** The provider that owns writes and is tried first for reads. */
  readonly provider: ProviderId
  /** Extra providers that should also hold a copy, for locality or durability. */
  readonly replicateTo?: readonly ProviderId[]
}
