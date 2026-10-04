/**
 * Bounded backend client.
 *
 * Every tool call in the gateway ends up here. The client is deliberately
 * small in what it will do: one request, a hard deadline, a response byte cap,
 * locale headers, and an optional bearer token. It never retries, never
 * follows a caller-supplied absolute URL, and never hands the model more bytes
 * than the budget allows. Backend errors are normalised into a single type so
 * a tool handler can decide what the agent is allowed to see.
 */

export interface BackendClientOptions {
  apiBaseUrl: string
  locale?: string
  accessToken?: string | null
  timeoutMs?: number
  maxBytes?: number
}

export interface BackendRequest {
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  requireAuth?: boolean
}

export interface BackendResult<T> {
  data: T
  truncated: boolean
}

export class BackendError extends Error {
  readonly status: number
  readonly code: string | null
  readonly payload: unknown

  constructor(message: string, status: number, code: string | null = null, payload: unknown = null) {
    super(message)
    this.name = 'BackendError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

function normalizeLocale(locale?: string): string {
  const value = (locale ?? 'en').trim().toLowerCase()
  return value.startsWith('en') || value === '' ? 'en' : value.split(/[-_]/)[0]
}

function truncateJson(value: unknown, maxBytes: number): BackendResult<unknown> {
  const json = JSON.stringify(value)
  if (!json) {
    return { data: value, truncated: false }
  }

  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return { data: value, truncated: false }
  }

  // A list is the shape that actually blows the budget, so drop trailing
  // items and keep the envelope intact. The agent still learns how many items
  // existed, so a follow-up request can page to the rest.
  if (value && typeof value === 'object') {
    const root = value as Record<string, unknown>
    const result = root.result as Record<string, unknown> | undefined

    if (result && Array.isArray(result.data)) {
      const kept: unknown[] = []
      let used = Buffer.byteLength(
        JSON.stringify({ ...root, result: { ...result, data: [] } }),
        'utf8',
      )

      for (const item of result.data) {
        const cost = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
        if (used + cost > maxBytes) break
        kept.push(item)
        used += cost
      }

      return {
        data: {
          ...root,
          result: {
            ...result,
            data: kept,
            truncated: true,
            returned: kept.length,
            original_count: result.data.length,
          },
        },
        truncated: true,
      }
    }
  }

  // Nothing worth salvaging fits: say so rather than trickle raw bytes.
  return {
    data: {
      success: false,
      truncated: true,
      message: `Response exceeded ${maxBytes} bytes; request a narrower resource or a smaller page.`,
    },
    truncated: true,
  }
}

function mapStatus(status: number, payload: unknown): BackendError {
  const body = (payload ?? {}) as Record<string, unknown>
  const code =
    typeof body.code === 'string'
      ? body.code
      : typeof (body.error as { code?: string } | undefined)?.code === 'string'
        ? (body.error as { code: string }).code
        : null
  const message = typeof body.message === 'string' ? body.message : null

  if (status === 402 || code === 'upgrade_required') {
    return new BackendError(message ?? 'Membership upgrade required for this entry.', status, 'upgrade_required', payload)
  }
  if (status === 401) {
    return new BackendError('The platform token is missing or expired.', 401, 'unauthorized', payload)
  }
  if (status === 403) {
    return new BackendError(message ?? 'Permission denied.', 403, code ?? 'forbidden', payload)
  }
  if (status === 404) {
    return new BackendError(message ?? 'Resource not found.', 404, 'not_found', payload)
  }
  if (status === 429) {
    return new BackendError('Rate limited by the backend; retry shortly.', 429, 'rate_limited', payload)
  }

  return new BackendError(message ?? `Backend request failed (${status}).`, status, code, payload)
}

export function createBackendClient(options: BackendClientOptions) {
  const base = options.apiBaseUrl.replace(/\/+$/, '')
  const locale = normalizeLocale(options.locale)
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 200_000
  const token = options.accessToken || null

  async function request<T = unknown>(req: BackendRequest): Promise<BackendResult<T>> {
    if (req.requireAuth && !token) {
      throw new BackendError(
        'Authorization required. Complete sign-in, exchange the session for a platform token, and retry.',
        401,
        'unauthorized',
      )
    }

    const path = req.path.startsWith('/') ? req.path.slice(1) : req.path
    const url = new URL(path, `${base}/`)

    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': locale,
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const method = req.method ?? 'GET'
    const init: RequestInit = { method, headers }
    if (method !== 'GET' && req.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(req.body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        throw mapStatus(response.status, payload)
      }

      return truncateJson(payload, maxBytes) as BackendResult<T>
    } catch (err) {
      if (err instanceof BackendError) throw err
      if ((err as Error)?.name === 'AbortError') {
        throw new BackendError(`Backend did not respond within ${timeoutMs}ms.`, 504, 'timeout')
      }
      throw new BackendError((err as Error)?.message ?? 'Backend unreachable.', 502, 'bad_gateway')
    } finally {
      clearTimeout(timer)
    }
  }

  return { locale, hasToken: Boolean(token), request }
}

export type BackendClient = ReturnType<typeof createBackendClient>
