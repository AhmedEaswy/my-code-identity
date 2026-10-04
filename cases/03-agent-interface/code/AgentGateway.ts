/**
 * The agent gateway.
 *
 * One class fronting one content platform. It advertises a tool list, enforces
 * which tools need a bearer token, and translates each call into exactly one
 * bounded backend request. Handlers stay thin on purpose: the interesting
 * policy lives in the registry (what is allowed) and the client (how much is
 * allowed), so a bug in a single handler cannot widen the surface.
 */

import {
  BackendError,
  createBackendClient,
  type BackendClient,
  type BackendResult,
} from './BoundedBackendClient'
import { fetchPageMarkdown, type PageMarkdownResult } from './markdown-negotiation'
import {
  COMMENT_PATH,
  GATED_DETAIL_PATH,
  LISTABLE_COLLECTIONS,
  PAGINATION_FREE,
  PUBLIC_DETAIL_PATH,
  SUGGESTION_TYPES,
  TOOLS,
  ToolInputError,
  assertSafeId,
  collectionPath,
  visibleTools,
  type ListableCollection,
  type ToolSpec,
} from './ToolRegistry'
import { resolveDiscoveryUrls, type DiscoveryUrls } from './discovery'

export interface GatewayContext {
  siteUrl: string
  apiBaseUrl: string
  accessToken: string | null
  locale?: string
  timeoutMs?: number
  maxBytes?: number
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

/** Markdown returned by a page tool is capped well below the JSON budget. */
const PAGE_MARKDOWN_MAX_CHARS = 40_000

function okJson(data: unknown): ToolResult {
  return { ok: true, data }
}

function toolError(err: unknown): ToolResult {
  if (err instanceof BackendError) {
    return { ok: false, error: { code: err.code ?? 'backend_error', message: err.message } }
  }
  if (err instanceof ToolInputError) {
    return { ok: false, error: { code: err.code, message: err.message } }
  }
  return { ok: false, error: { code: 'internal', message: (err as Error)?.message ?? 'Tool failed.' } }
}

export class AgentGateway {
  private readonly urls: DiscoveryUrls

  constructor(private readonly ctx: GatewayContext) {
    this.urls = resolveDiscoveryUrls({ siteUrl: ctx.siteUrl, backendBase: ctx.apiBaseUrl })
  }

  listTools(): Array<Record<string, unknown>> {
    return visibleTools(this.authenticated()).map((tool: ToolSpec) => ({
      name: tool.name,
      title: tool.title,
      description: tool.summary,
      annotations: {
        readOnlyHint: !tool.mutates,
        destructiveHint: false,
      },
    }))
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const spec = TOOLS.find((tool) => tool.name === name)

    try {
      if (!spec) throw new ToolInputError(`Unknown tool '${name}'.`)
      this.assertAuthorized(spec)

      return await this.dispatch(spec, args)
    } catch (err) {
      return toolError(err)
    }
  }

  private authenticated(): boolean {
    return Boolean(this.ctx.accessToken)
  }

  /**
   * The one place a bearer requirement is enforced. Showing a protected tool
   * without a token and then failing it at call time would waste a round trip
   * and confuse the agent; this fails immediately with a message a human can
   * act on.
   */
  private assertAuthorized(spec: ToolSpec): void {
    if (spec.auth === 'bearer' && !this.authenticated()) {
      throw new BackendError(
        `${spec.name} requires a platform bearer token. Complete sign-in, exchange the session, and retry.`,
        401,
        'unauthorized',
      )
    }
  }

  private client(locale?: string): BackendClient {
    return createBackendClient({
      apiBaseUrl: this.ctx.apiBaseUrl,
      locale: locale || this.ctx.locale || 'en',
      accessToken: this.ctx.accessToken,
      timeoutMs: this.ctx.timeoutMs,
      maxBytes: this.ctx.maxBytes,
    })
  }

  private async dispatch(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolResult> {
    switch (spec.name) {
      case 'discover_platform':
        return this.discover(String(args.locale ?? this.ctx.locale ?? 'en'))

      case 'search_content':
        return this.searchContent(args)

      case 'list_collection':
        return this.listCollection(args)

      case 'get_public_entry':
        return this.getPublicEntry(args)

      case 'get_page_markdown':
        return this.getPageMarkdown(args)

      case 'get_account':
        return this.request('account/me', args, { requireAuth: true, wrap: 'account' })

      case 'get_protected_entry':
        return this.getProtectedEntry(args)

      case 'list_bookmarks':
        return this.listBookmarks(args)

      case 'manage_bookmark':
        return this.manageBookmark(args)

      default:
        throw new ToolInputError(`Tool '${spec.name}' has no handler.`)
    }
  }

  private async discover(locale: string): Promise<ToolResult> {
    const catalog = Object.entries(LISTABLE_COLLECTIONS).map(([name, path]) => ({
      collection: name,
      href: `${this.ctx.apiBaseUrl.replace(/\/+$/, '')}${path}`,
    }))

    return okJson({
      name: 'Meridian',
      site_url: this.urls.siteUrl,
      tool_endpoint: this.urls.toolEndpoint,
      api_base_url: this.ctx.apiBaseUrl,
      locale,
      locales: ['en'],
      discovery: {
        api_catalog: `${this.urls.siteUrl}/.well-known/api-catalog`,
        tool_card: this.urls.toolCard,
        auth_doc: this.urls.authDoc,
        protected_resource: this.urls.resourceMetadata,
        authorization_server: this.urls.serverMetadata,
      },
      auth: {
        mode: 'human_oidc_then_platform_bearer',
        note: 'A human signs in at claim_uri; register_uri then exchanges that session for a platform bearer token.',
        claim_uri: this.urls.signInUrl,
        register_uri: this.urls.exchangeUrl,
        bearer_header: 'Authorization: Bearer <platform_token>',
        authenticated: this.authenticated(),
      },
      public_catalog_item_count: catalog.length,
      public_catalog_sample: catalog.slice(0, 12),
      tools: visibleTools(this.authenticated()).map((tool) => tool.name),
    })
  }

  private async searchContent(args: Record<string, unknown>): Promise<ToolResult> {
    const type = String(args.type ?? '')
    const query = String(args.query ?? '').trim()
    const limit = Number(args.limit ?? 8)
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)

    if ((SUGGESTION_TYPES as readonly string[]).includes(type)) {
      const { data, truncated } = await api.request({
        path: `${type}/suggestions`,
        query: { search: query, limit },
      })
      return okJson({ type, query, limit, truncated, result: data })
    }

    if (type in LISTABLE_COLLECTIONS) {
      const { data, truncated } = await api.request({
        path: collectionPath(type),
        query: { search: query, limit, page: 1 },
      })
      return okJson({ type, query, limit, mode: 'list_search', truncated, result: data })
    }

    throw new ToolInputError(`Unsupported search type '${type}'.`)
  }

  private async listCollection(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.collection ?? '') as ListableCollection
    const path = collectionPath(name)
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)

    const query: Record<string, string | number> = {}
    if (!PAGINATION_FREE.includes(name)) {
      query.page = Number(args.page ?? 1)
      query.limit = Number(args.limit ?? 12)
    }
    if (typeof args.search === 'string' && args.search) query.search = args.search

    const { data, truncated } = await api.request({ path, query })
    return okJson({ collection: name, truncated, result: data })
  }

  private async getPublicEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const id = assertSafeId(args.id)
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)

    if (args.kind === 'article' || args.kind === 'release') {
      const base = PUBLIC_DETAIL_PATH[args.kind]
      const { data, truncated } = await api.request({ path: `${base.replace(/^\//, '')}/${id}` })
      return okJson({ kind: args.kind, id, truncated, result: data })
    }

    if (args.kind === 'comments') {
      const type = String(args.comment_type ?? '')
      const base = (COMMENT_PATH as Record<string, string | undefined>)[type]
      if (!base) {
        throw new ToolInputError('comment_type is required when kind=comments (article|guide|tutorial).')
      }
      const { data, truncated } = await api.request({ path: `${base.replace(/^\//, '')}/${id}` })
      return okJson({ kind: 'comments', comment_type: type, id, truncated, result: data })
    }

    throw new ToolInputError(`Unsupported kind '${String(args.kind)}'.`)
  }

  private async getProtectedEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const type = String(args.type ?? '')
    const id = assertSafeId(args.id)
    const base = (GATED_DETAIL_PATH as Record<string, string | undefined>)[type]

    if (!base) throw new ToolInputError(`Unknown gated type '${type}'.`)

    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)
    const { data, truncated } = await api.request({
      path: `${base.replace(/^\//, '')}/${id}`,
      requireAuth: true,
    })

    return okJson({ type, id, truncated, result: data })
  }

  private async listBookmarks(args: Record<string, unknown>): Promise<ToolResult> {
    const type = String(args.type ?? 'article')
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)
    const { data, truncated } = await api.request({
      path: 'bookmarks',
      requireAuth: true,
      query: { type, page: Number(args.page ?? 1), limit: Number(args.limit ?? 12) },
    })

    return okJson({ type, truncated, result: data })
  }

  private async manageBookmark(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? '')
    if (action !== 'add' && action !== 'remove') {
      throw new ToolInputError('action must be add or remove.')
    }

    const id = assertSafeId(args.id)
    const type = String(args.type ?? '')
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)
    const { data, truncated } = await api.request({
      path: `bookmarks/${action}`,
      method: 'POST',
      requireAuth: true,
      body: { id, type },
    })

    return okJson({ action, type, id, truncated, result: data })
  }

  private async getPageMarkdown(args: Record<string, unknown>): Promise<ToolResult> {
    const path = String(args.path ?? '')
    let page: PageMarkdownResult

    try {
      page = await fetchPageMarkdown(path, {
        siteUrl: this.ctx.siteUrl,
        timeoutMs: this.ctx.timeoutMs,
        maxChars: Math.min(
          Math.floor((this.ctx.maxBytes ?? 200_000) / 2),
          PAGE_MARKDOWN_MAX_CHARS,
        ),
      })
    } catch (err) {
      throw new ToolInputError((err as Error).message)
    }

    return okJson(page)
  }

  private async request(
    path: string,
    args: Record<string, unknown>,
    options: { requireAuth: boolean; wrap: string },
  ): Promise<ToolResult> {
    const api = this.client(typeof args.locale === 'string' ? args.locale : undefined)
    const { data, truncated }: BackendResult<unknown> = await api.request({ path, requireAuth: options.requireAuth })

    return okJson({ [options.wrap]: data, truncated, authenticated: true })
  }
}
