import type { LiveSession, SessionRoute, Viewer } from './accessPolicy'
import { isPreviewPath, resolveRedirect } from './accessPolicy'

/**
 * The one place the policy is applied. Both routes for a session run this
 * guard, and it decides from the same pure function the page uses, so a
 * component cannot grow its own idea of who may see what. The session is
 * fetched once, on the server, and the page reuses that answer under the same
 * key — the redirect and the render are two readers of one decision.
 */

interface SessionShowResponse {
  result?: {
    viewer?: Viewer
    session?: LiveSession
  }
}

export default defineNuxtRouteMiddleware(async (to) => {
  const id = to.params.id

  if (!id || Array.isArray(id))
    return

  const currentRoute: SessionRoute = isPreviewPath(to.path) ? 'preview' : 'session'
  const localePath = useLocalePath()

  const { data } = await useApi(`sessions/${id}`, 'GET', {
    server: true,
    lazy: false,
    key: `session-${id}`,
    success_toast: false,
    error_toast: false,
  })

  const payload = data.value as SessionShowResponse | null
  const viewer = payload?.result?.viewer ?? null
  const session = payload?.result?.session ?? null

  const redirectTo = resolveRedirect(viewer, session, currentRoute)

  if (!redirectTo)
    return

  return navigateTo(localePath({ name: redirectTo, params: { id } }), { redirectCode: 302 })
})
