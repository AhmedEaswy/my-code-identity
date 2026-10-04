import { computed, onBeforeUnmount, onMounted, ref, toValue, type MaybeRefOrGetter } from 'vue'

/**
 * The only piece of the page allowed to know the client clock. The server has no
 * `Date.now()` worth rendering and the browser has a different timezone, so the
 * countdown is deliberately empty until the component mounts: the server and the
 * first client render both produce the same placeholder, and only then does the
 * tick start. That is the whole hydration contract — not a flag that silences a
 * mismatch after the fact.
 */

const TIMEZONE_COOKIE = 'viewer-tz'
export const DEFAULT_TIMEZONE = 'UTC'
const DEFAULT_TICK_MS = 1000

export interface CountdownParts {
  days: number
  hours: number
  minutes: number
  seconds: number
  totalMs: number
}

export interface CountdownSource {
  startsAt: string | null
}

export function toInstant(value: string | Date | number | null | undefined): Date | null {
  if (value == null || value === '')
    return null

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

/** Days/hours/minutes/seconds until `target`; `null` when there is no target. */
export function countdownParts(target: Date | null, now: number): CountdownParts | null {
  if (!target)
    return null

  const totalMs = target.getTime() - now

  if (totalMs <= 0)
    return { days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0 }

  const totalSeconds = Math.floor(totalMs / 1000)

  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMs,
  }
}

/** The browser's own zone, or `null` when the runtime cannot resolve one. */
export function browserTimezone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null
}

export function useSessionCountdown(
  source: MaybeRefOrGetter<CountdownSource | null | undefined>,
  options: { intervalMs?: number } = {},
) {
  const tzCookie = useCookie<string | null>(TIMEZONE_COOKIE, {
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })

  const timezone = ref(tzCookie.value || DEFAULT_TIMEZONE)
  const now = ref<number | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  const target = computed(() => toInstant(toValue(source)?.startsAt))

  // `null` until mounted, so server output and the first client render agree.
  const parts = computed<CountdownParts | null>(() =>
    now.value === null ? null : countdownParts(target.value, now.value),
  )

  const ready = computed(() => now.value !== null)

  const tick = (): void => {
    now.value = Date.now()
  }

  onMounted(() => {
    const resolved = browserTimezone()

    if (resolved) {
      timezone.value = resolved

      if (tzCookie.value !== resolved)
        tzCookie.value = resolved
    }

    tick()

    const intervalMs = options.intervalMs ?? DEFAULT_TICK_MS

    if (intervalMs > 0)
      timer = setInterval(tick, intervalMs)
  })

  onBeforeUnmount(() => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return { parts, target, timezone, ready }
}
