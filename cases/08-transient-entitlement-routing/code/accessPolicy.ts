/**
 * One decision for a live-session page: given who is looking, which session, and
 * the current instant, say what the page may show and which route that belongs
 * on. Nothing here touches the DOM, a store, or the network — the route guard
 * and the page call the same function, so the two can never disagree.
 *
 * The policy reads exactly two axes:
 *   - entitlement: `Viewer.canAccess` (a grant) and `Viewer.isFree` (no grant
 *     needed) — who they are and what they paid for
 *   - time: `upcoming | live | past`, recomputed from the session's bounds and
 *     `now`, never trusted from a snapshot taken when the page was rendered
 */

export type SessionStatus = 'upcoming' | 'live' | 'past'

/** What the page is allowed to render. */
export type SessionView = 'preview' | 'member' | 'locked'

/** The two routes a session can live on. */
export type SessionRoute = 'preview' | 'session'

/**
 * The viewer's relationship to one session, as the backend already resolved it.
 * `canAccess` is the entitlement; `isFree` marks a session that needs no grant.
 * `status` is the server's last-known position in time — a fallback only,
 * because it is stale the moment a tab is left open across the start.
 */
export interface Viewer {
  canAccess: boolean
  isFree: boolean
  status: SessionStatus
}

/** The timing facts the decision needs; everything else is presentation. */
export interface LiveSession {
  id: number
  startsAt: string | null
  endsAt: string | null
}

/** How long a session counts as live after its start when no end is known. */
const DEFAULT_LIVE_WINDOW_MS = 3 * 60 * 60 * 1000

/** View -> the route that renders it. Two views can share one route. */
export const ROUTE_FOR_VIEW: Record<SessionView, SessionRoute> = {
  member: 'session',
  locked: 'session',
  preview: 'preview',
}

export function toInstant(value: string | Date | number | null | undefined): Date | null {
  if (value == null || value === '')
    return null

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Recompute the position in time from the session's own bounds. The server's
 * `fallback` is used only when it never sent a start — never to override a real
 * clock, or a page left open across the start would keep showing "upcoming".
 */
export function sessionStatusAt(session: LiveSession, fallback: SessionStatus, now: number): SessionStatus {
  const start = toInstant(session.startsAt)

  if (start === null)
    return fallback

  if (now < start.getTime())
    return 'upcoming'

  const end = toInstant(session.endsAt)

  if (end !== null)
    return now < end.getTime() ? 'live' : 'past'

  return now - start.getTime() < DEFAULT_LIVE_WINDOW_MS ? 'live' : 'past'
}

/**
 * The narrow question on its own: may this request use the marketing preview
 * route at all? A grant makes it a member instead; otherwise a free session is
 * previewable, and an upcoming paid session is previewable to sell it. Live or
 * past paid sessions are not.
 */
export function canPreview(viewer: Viewer, session: LiveSession, now: number = Date.now()): boolean {
  if (viewer.canAccess)
    return false

  return viewer.isFree || sessionStatusAt(session, viewer.status, now) === 'upcoming'
}

/**
 * The whole policy. Entitlement wins outright — a grant is a member. Otherwise
 * the clock only ever widens the marketing preview: a free session is always
 * previewable, and an upcoming paid session is previewable to sell it. A paid
 * session that is live or past *without* a grant is locked, never previewed —
 * a past paid session is a subscriber's replay, not a public archive.
 */
export function decideView(viewer: Viewer, session: LiveSession, now: number = Date.now()): SessionView {
  if (viewer.canAccess)
    return 'member'

  if (canPreview(viewer, session, now))
    return 'preview'

  return 'locked'
}

export function routeForView(view: SessionView): SessionRoute {
  return ROUTE_FOR_VIEW[view]
}

/**
 * Where the guard should send the request, or `null` when the current route
 * already matches. A session that has not loaded yields no redirect: a missing
 * session is a 404 for the page to own, not a routing decision.
 */
export function resolveRedirect(
  viewer: Viewer | null | undefined,
  session: LiveSession | null | undefined,
  currentRoute: SessionRoute,
  now: number = Date.now(),
): SessionRoute | null {
  if (!viewer || !session)
    return null

  const target = routeForView(decideView(viewer, session, now))

  return target === currentRoute ? null : target
}

export function isPreviewPath(path: string): boolean {
  return /\/sessions\/preview\//.test(path)
}
