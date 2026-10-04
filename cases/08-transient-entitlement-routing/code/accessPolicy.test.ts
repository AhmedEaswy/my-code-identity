import { describe, expect, it } from 'vitest'
import {
  canPreview,
  decideView,
  isPreviewPath,
  resolveRedirect,
  sessionStatusAt,
  type LiveSession,
  type SessionStatus,
  type SessionView,
  type Viewer,
} from './accessPolicy'

/**
 * The policy is a behavioural contract, so the tests describe behaviour: the
 * full entitlement-by-time matrix, a stale server snapshot corrected by the
 * clock, the fallback when the server sent no start, and the two redirects.
 */

const NOW = Date.parse('2026-03-01T12:00:00Z')
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

const viewer = (overrides: Partial<Viewer> = {}): Viewer =>
  ({ canAccess: false, isFree: false, status: 'upcoming', ...overrides })

const session = (overrides: Partial<LiveSession> = {}): LiveSession =>
  ({ id: 1, startsAt: at(30), endsAt: at(90), ...overrides })

describe('decideView', () => {
  it.each<[string, Partial<Viewer>, Partial<LiveSession>, SessionView]>([
    ['a grant is a member, whatever the clock says',
      { canAccess: true }, { startsAt: at(-180), endsAt: at(-120) }, 'member'],
    ['a free session is previewable even after it ends',
      { isFree: true }, { startsAt: at(-180), endsAt: at(-120) }, 'preview'],
    ['an upcoming paid session is previewable to sell it',
      {}, { startsAt: at(30), endsAt: at(90) }, 'preview'],
    ['a live paid session without a grant is locked',
      {}, { startsAt: at(-30), endsAt: at(30) }, 'locked'],
    ['a past paid session without a grant stays locked',
      {}, { startsAt: at(-180), endsAt: at(-120) }, 'locked'],
  ])('%s', (_label, viewerOverrides, sessionOverrides, expected) => {
    expect(decideView(viewer(viewerOverrides), session(sessionOverrides), NOW)).toBe(expected)
  })
})

describe('canPreview', () => {
  it('is false when the viewer holds a grant, and for a live paid session', () => {
    expect(canPreview(viewer({ canAccess: true }), session(), NOW)).toBe(false)
    expect(canPreview(viewer(), session({ startsAt: at(-30), endsAt: at(30) }), NOW)).toBe(false)
  })

  it('is true for a free session and for an upcoming paid one', () => {
    expect(canPreview(viewer({ isFree: true }), session({ startsAt: at(-180), endsAt: at(-120) }), NOW)).toBe(true)
    expect(canPreview(viewer(), session({ startsAt: at(30) }), NOW)).toBe(true)
  })
})

describe('sessionStatusAt', () => {
  it.each<[string, string, string, SessionStatus]>([
    ['before the start is upcoming', at(30), at(90), 'upcoming'],
    ['between start and end is live', at(-30), at(30), 'live'],
    ['after the end is past', at(-180), at(-120), 'past'],
  ])('%s', (_label, startsAt, endsAt, expected) => {
    expect(sessionStatusAt(session({ startsAt, endsAt }), 'upcoming', NOW)).toBe(expected)
  })

  it('does not trust a snapshot the clock has outlived', () => {
    expect(sessionStatusAt(session({ startsAt: at(-5), endsAt: at(55) }), 'upcoming', NOW)).toBe('live')
  })

  it('falls back to the server status when no start was sent', () => {
    expect(sessionStatusAt(session({ startsAt: null }), 'past', NOW)).toBe('past')
  })

  it('keeps a session live for the default window when no end is known', () => {
    expect(sessionStatusAt(session({ startsAt: at(-30), endsAt: null }), 'upcoming', NOW)).toBe('live')
    expect(sessionStatusAt(session({ startsAt: at(-300), endsAt: null }), 'upcoming', NOW)).toBe('past')
  })

  it('treats an unparseable start as absent', () => {
    expect(sessionStatusAt(session({ startsAt: 'not a date' }), 'upcoming', NOW)).toBe('upcoming')
  })
})

describe('resolveRedirect', () => {
  it('sends the member route to the preview when only a preview is allowed', () => {
    expect(resolveRedirect(viewer(), session({ startsAt: at(30) }), 'session', NOW)).toBe('preview')
  })

  it('sends the preview route to the member route for a locked paid session', () => {
    expect(resolveRedirect(viewer(), session({ startsAt: at(-30), endsAt: at(30) }), 'preview', NOW)).toBe('session')
  })

  it('stays put when the current route already matches', () => {
    expect(resolveRedirect(viewer({ canAccess: true }), session(), 'session', NOW)).toBeNull()
    expect(resolveRedirect(viewer(), session({ startsAt: at(30) }), 'preview', NOW)).toBeNull()
  })

  it('keeps a past paid session on the locked member route', () => {
    const past = session({ startsAt: at(-180), endsAt: at(-120) })

    expect(resolveRedirect(viewer(), past, 'session', NOW)).toBeNull()
    expect(resolveRedirect(viewer(), past, 'preview', NOW)).toBe('session')
  })

  it('does nothing while the session has not loaded', () => {
    expect(resolveRedirect(null, null, 'session', NOW)).toBeNull()
    expect(resolveRedirect(viewer(), null, 'session', NOW)).toBeNull()
  })
})

describe('isPreviewPath', () => {
  it('recognises the guest path and only the guest path', () => {
    expect(isPreviewPath('/en/sessions/preview/42')).toBe(true)
    expect(isPreviewPath('/en/sessions/42')).toBe(false)
  })
})
