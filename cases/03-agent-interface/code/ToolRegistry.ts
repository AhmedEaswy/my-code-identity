/**
 * The declaration sheet for the agent surface.
 *
 * Everything an agent can reach is named here exactly once: the tool list, the
 * backend paths each tool is permitted to touch, and the shape checks applied
 * to caller input before any path is assembled. The gateway executes; this file
 * decides. Splitting them means the allowlist can be reviewed on its own, and a
 * new tool cannot quietly reach a route nobody declared.
 */

export type AuthMode = 'public' | 'bearer'

export interface ToolSpec {
  readonly name: string
  readonly title: string
  readonly summary: string
  readonly auth: AuthMode
  /** True when the call changes server state; becomes destructiveHint:false. */
  readonly mutates: boolean
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'discover_platform',
    title: 'Discover the platform',
    summary: 'Endpoints, tool list, locales, and how to authenticate. Start here.',
    auth: 'public',
    mutates: false,
  },
  {
    name: 'search_content',
    title: 'Search content',
    summary: 'Search by type using a suggestions endpoint, or fall back to a filtered list.',
    auth: 'public',
    mutates: false,
  },
  {
    name: 'list_collection',
    title: 'List a collection',
    summary: 'Read an allowlisted public collection with pagination.',
    auth: 'public',
    mutates: false,
  },
  {
    name: 'get_public_entry',
    title: 'Get a public entry',
    summary: 'Fetch an openly readable detail record or its anonymous comments.',
    auth: 'public',
    mutates: false,
  },
  {
    name: 'get_page_markdown',
    title: 'Get a page as Markdown',
    summary: 'Fetch a same-origin HTML page rendered as Markdown.',
    auth: 'public',
    mutates: false,
  },
  {
    name: 'get_account',
    title: 'Get the signed-in account',
    summary: 'Return the account summary for the bearer token.',
    auth: 'bearer',
    mutates: false,
  },
  {
    name: 'get_protected_entry',
    title: 'Get a gated entry',
    summary: 'Fetch gated detail for an entry behind membership. May refuse with upgrade_required.',
    auth: 'bearer',
    mutates: false,
  },
  {
    name: 'list_bookmarks',
    title: 'List bookmarks',
    summary: 'List the signed-in account bookmarks, filtered by entry type.',
    auth: 'bearer',
    mutates: false,
  },
  {
    name: 'manage_bookmark',
    title: 'Add or remove a bookmark',
    summary: 'Add or remove a bookmark for the signed-in account.',
    auth: 'bearer',
    mutates: true,
  },
]

/** Path per listable collection. The leading slash is stripped on the wire. */
export const LISTABLE_COLLECTIONS = {
  articles: '/articles',
  guides: '/guides',
  courses: '/courses',
  briefs: '/briefs',
  releases: '/releases',
  talks: '/talks',
  topics: '/topics',
  testimonials: '/testimonials',
  home_feed: '/home-feed',
} as const

export type ListableCollection = keyof typeof LISTABLE_COLLECTIONS

/** Aggregate endpoints return a fixed shape and ignore page/limit. */
export const PAGINATION_FREE: readonly ListableCollection[] = [
  'topics',
  'testimonials',
  'home_feed',
]

/** Types that expose a dedicated suggestions endpoint. */
export const SUGGESTION_TYPES = ['guides', 'courses', 'discussions'] as const

/** Types whose detail record is readable without a token. */
export const PUBLIC_DETAIL_PATH = {
  article: '/articles',
  release: '/releases',
} as const

/** Types whose detail record is gated behind membership. */
export const GATED_DETAIL_PATH = {
  guide: '/guides',
  course: '/courses',
  tutorial: '/tutorials',
  talk: '/talks',
  tool: '/tools',
} as const

/** Types that accept anonymous comments under the same id scheme. */
export const COMMENT_PATH = {
  article: '/articles',
  guide: '/guides',
  tutorial: '/tutorials',
} as const

export class ToolInputError extends Error {
  readonly code: string

  constructor(message: string, code = 'bad_request') {
    super(message)
    this.name = 'ToolInputError'
    this.code = code
  }
}

/**
 * Ids are opaque, but they are also interpolated into a URL. Restricting them
 * to a conservative character set means a caller can never smuggle a slash, a
 * traversal segment, or a query into the path a tool builds.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function assertSafeId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''

  if (!ID_PATTERN.test(id)) {
    throw new ToolInputError(
      'id must be 1-64 characters of letters, digits, hyphen, or underscore.',
    )
  }

  return id
}

export function collectionPath(name: unknown): string {
  const path = (LISTABLE_COLLECTIONS as Record<string, string | undefined>)[String(name)]

  if (!path) {
    throw new ToolInputError(`Unknown collection '${String(name)}'.`)
  }

  return path.replace(/^\//, '')
}

/**
 * The tools a caller may see or invoke. Bearer-only tools are hidden rather
 * than shown-and-failed: an unauthenticated client should not be walked into a
 * wall it cannot climb without a human.
 */
export function visibleTools(authenticated: boolean): readonly ToolSpec[] {
  return TOOLS.filter((tool) => tool.auth === 'public' || authenticated)
}
