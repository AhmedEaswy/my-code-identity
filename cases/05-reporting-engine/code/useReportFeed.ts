import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, unref, watch, type MaybeRef } from 'vue'

/**
 * One request for a report page. A change of filters waits 300 ms — so a run
 * of clicks becomes one request — and cancels whatever is in flight; a change
 * of lens alone goes at once, because the filters decide the expensive part
 * of the query and the lens is only a different cut of the same answer. The
 * last answer of every URL is kept in memory for three minutes (the server's
 * own freshness), so going back and opening an lens already seen are instant
 * and never touch the network. Switching the metric of a visual is not a
 * request at all: every metric is already in the answer.
 */

export interface LensMetric {
  key: string
  label: string
  format: string
}

export interface LensVisual {
  type: string
  metric: string
  metrics: LensMetric[]
  data: Record<string, unknown>
}

export interface Lens {
  key: string
  snapshot: boolean
  visual: LensVisual | null
  table: unknown | null
}

export interface ReportScope {
  workspace?: { name: string, count: number }
}

export interface ReportPayload {
  page: string
  scope?: ReportScope
  kpis?: unknown[]
  lenses?: string[]
  lens: Lens | null
  generated_at: string
  extras?: Record<string, unknown>
}

export type ReportFetcher = (endpoint: string, query: Record<string, unknown>, signal: AbortSignal) => Promise<ReportPayload>

export interface UseReportFeedOptions {
  endpoint: MaybeRef<string>
  query: MaybeRef<Record<string, unknown>>
  fetcher?: ReportFetcher
  debounce?: number
}

const FRESH_FOR = 3 * 60 * 1000
const KEPT = 24

/** Response memory, shared by every report page: the oldest entry is the one let go. */
const memory = new Map<string, { payload: ReportPayload, at: number }>()

/** Forget every response held in memory. */
export const clearReportMemory = (): void => memory.clear()

const remember = (key: string, payload: ReportPayload): void => {
  // Re-inserting moves the key to the end, so the map order is the recency order.
  memory.delete(key)
  memory.set(key, { payload, at: Date.now() })
  while (memory.size > KEPT)
    memory.delete(memory.keys().next().value as string)
}

const recall = (key: string): ReportPayload | null => {
  const entry = memory.get(key)

  return entry && Date.now() - entry.at < FRESH_FOR ? entry.payload : null
}

/** Stable text for a query, so two orders of the same parameters hit one entry. */
const serializeQuery = (query: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const key of Object.keys(query).sort()) {
    for (const value of Array.isArray(query[key]) ? query[key] : [query[key]])
      params.append(key, String(value))
  }

  return params.toString()
}

const keyOf = (endpoint: string, query: Record<string, unknown>): string => `${endpoint}?${serializeQuery(query)}`

const withoutLens = (query: Record<string, unknown>): Record<string, unknown> => {
  const { lens: _lens, ...rest } = query

  return rest
}

export type ReportFeedState = 'loading' | 'error' | 'forbidden' | 'empty' | 'ready'

/**
 * What the page shows. A refusal (a 401 for a permission this account lacks)
 * is a forbidden page, never a sign-out. A scope that covers nothing — a
 * workspace outside the account's reach — answers with no figures at all: the
 * page explains that instead of drawing a row of blank cards.
 */
export function reportFeedState(payload: ReportPayload | null, error: string | null, status: number | null): ReportFeedState {
  if (!payload) {
    if (error === null)
      return 'loading'

    return status === 401 || status === 403 ? 'forbidden' : 'error'
  }

  return payload.scope?.workspace?.count === 0 || !payload.kpis?.length ? 'empty' : 'ready'
}

/** A refused request, carrying the HTTP status when the API gave one. */
export class ReportRequestError extends Error {
  constructor(message: string, public status: number | null) {
    super(message)
  }
}

/**
 * The console's own API client: authenticated, already in the account's
 * language. Its 401 is a permission the account does not hold, and must be
 * reported by the page, never allowed to fall into a sign-out path.
 */
export const apiReportFetcher: ReportFetcher = async (endpoint, query, signal) => {
  const body = await $fetch<{ success: boolean, result: ReportPayload, message?: string }>(endpoint, { query, signal })
    .catch((failure: any) => {
      throw new ReportRequestError(failure?.data?.message ?? failure?.message ?? '', failure?.statusCode ?? failure?.status ?? null)
    })

  if (!body?.success)
    throw new ReportRequestError(body?.message ?? '', null)

  return body.result
}

export function useReportFeed(options: UseReportFeedOptions) {
  const fetcher = options.fetcher ?? apiReportFetcher
  const wait = options.debounce ?? 300

  const payload = shallowRef<ReportPayload | null>(null)
  const loading = ref(false)

  /** The server's message, `''` when it gave none; `null` when the last request did not fail. */
  const error = ref<string | null>(null)

  /** The status of that failure, when there was one (`401`: not allowed). */
  const status = ref<number | null>(null)

  /** Which request is currently drawn, and which filter set it belongs to. */
  const shown = ref<{ key: string, filters: string } | null>(null)
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const key = computed(() => keyOf(unref(options.endpoint), unref(options.query)))
  const filtersKey = computed(() => keyOf(unref(options.endpoint), withoutLens(unref(options.query))))

  const show = (result: ReportPayload, requestKey: string, requestFilters: string): void => {
    payload.value = result
    shown.value = { key: requestKey, filters: requestFilters }
  }

  const cancel = (): void => {
    if (timer)
      clearTimeout(timer)
    timer = null
    controller?.abort()
    controller = null
    loading.value = false
  }

  const run = async (requestKey: string, requestFilters: string, endpoint: string, query: Record<string, unknown>): Promise<void> => {
    const current = new AbortController()
    controller = current
    loading.value = true
    error.value = null
    status.value = null

    try {
      const result = await fetcher(endpoint, query, current.signal)
      // A response that arrives after its request was abandoned answers a
      // question nobody is asking any more: drop it, do not redraw.
      if (current.signal.aborted)
        return
      remember(requestKey, result)
      show(result, requestKey, requestFilters)
    }
    catch (failure) {
      if (!current.signal.aborted) {
        error.value = failure instanceof Error ? failure.message : ''
        status.value = failure instanceof ReportRequestError ? failure.status : null
      }
    }
    finally {
      if (controller === current) {
        controller = null
        loading.value = false
      }
    }
  }

  const load = (immediate: boolean): Promise<void> | void => {
    const requestKey = key.value
    const requestFilters = filtersKey.value
    const endpoint = unref(options.endpoint)
    const query = { ...unref(options.query) }

    // Whatever is in flight answers a question the URL no longer asks.
    cancel()

    const kept = recall(requestKey)
    if (kept) {
      error.value = null
      status.value = null
      show(kept, requestKey, requestFilters)

      return
    }

    if (immediate || wait <= 0)
      return run(requestKey, requestFilters, endpoint, query)

    loading.value = true
    timer = setTimeout(() => {
      timer = null
      run(requestKey, requestFilters, endpoint, query)
    }, wait)
  }

  // A change of filters may wait; a change of lens alone must not, so the
  // wait is skipped exactly when the filter key is unchanged.
  watch(key, () => load(shown.value?.filters === filtersKey.value))

  /** The first request, at once. */
  const ready = load(true)

  if (getCurrentScope())
    onScopeDispose(cancel)

  /** The lens of the URL, once its answer is shown; `null` while another lens of the same filters is on its way. */
  const lens = computed<Lens | null>(() => (payload.value && shown.value?.key === key.value ? payload.value.lens : null))

  /** The same filters are drawn and another lens is coming: only the lens's place waits. */
  const lensLoading = computed(() => !!payload.value && shown.value?.filters === filtersKey.value && shown.value?.key !== key.value)

  /** Different filters are coming: the page keeps what it shows, dimmed. */
  const refreshing = computed(() => !!payload.value && shown.value?.filters !== filtersKey.value)

  const extras = computed<Record<string, unknown>>(() => payload.value?.extras ?? {})
  const state = computed(() => reportFeedState(payload.value, error.value, status.value))

  /** Drop the kept copy of the current URL and ask again. */
  const retry = (): Promise<void> | void => {
    memory.delete(key.value)

    return load(true)
  }

  return { payload, lens, loading, lensLoading, refreshing, error, status, state, extras, retry, ready }
}
