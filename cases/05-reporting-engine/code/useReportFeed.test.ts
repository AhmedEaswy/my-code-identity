import { nextTick, ref } from 'vue'
import { clearReportMemory, useReportFeed, type ReportPayload } from './useReportFeed'

/**
 * The feed is a behavioural contract, so the tests describe behaviour: one
 * request at once, a second identical URL served from memory, an in-flight
 * request abandoned when the filters change, one request for a burst of
 * clicks, and an lens that moves without redrawing the whole page.
 */

interface Call {
  query: Record<string, unknown>
  signal: AbortSignal
  resolve: (payload: ReportPayload) => void
  reject: (error: Error) => void
}

/** A server that answers only when told to. */
const server = () => {
  const calls: Call[] = []
  const fetcher = vi.fn((_endpoint: string, query: Record<string, unknown>, signal: AbortSignal) =>
    new Promise<ReportPayload>((resolve, reject) => calls.push({ query, signal, resolve, reject })))

  return { calls, fetcher }
}

/** A payload whose lens carries a visual of the given metrics. */
const pageOf = (lens: string, page = 'sessions', metrics = ['sessions']): ReportPayload => ({
  page,
  scope: { workspace: { name: 'All workspaces', count: 4 } },
  kpis: [{}],
  lenses: ['path', 'dropoff', 'peak'],
  lens: {
    key: lens,
    snapshot: false,
    visual: {
      type: 'coverage',
      metric: metrics[0],
      metrics: metrics.map(key => ({ key, label: key, format: 'int' })),
      data: Object.fromEntries(metrics.map(key => [key, {}])),
    },
    table: null,
  },
  generated_at: '2026-09-29T08:00:00Z',
  extras: {},
})

const byLens: Record<string, ReportPayload> = {
  path: pageOf('path', 'sessions', ['sessions', 'visits']),
  dropoff: pageOf('dropoff'),
  peak: pageOf('peak', 'sessions', ['sessions', 'started_at']),
}

/** Lets every pending promise settle, then Vue's own queue. */
const flush = async () => {
  for (let tick = 0; tick < 6; tick++)
    await Promise.resolve()
  await nextTick()
}

const answer = async (call: Call) => {
  call.resolve(byLens[String(call.query.lens)])
  await flush()
}

beforeEach(() => {
  clearReportMemory()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useReportFeed', () => {
  it('asks once at once, and draws the answer', async () => {
    const { calls, fetcher } = server()
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query: { period: '30d', lens: 'path' }, fetcher })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/analytics/sessions')
    expect(feed.loading.value).toBe(true)

    await answer(calls[0])
    expect(feed.payload.value?.page).toBe('sessions')
    expect(feed.lens.value?.key).toBe('path')
    expect(feed.loading.value).toBe(false)
    expect(feed.extras.value).toEqual({})
  })

  it('serves a second identical request from memory, without the server', async () => {
    const first = server()
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query: { period: '30d', lens: 'path' }, fetcher: first.fetcher })
    await answer(first.calls[0])

    const second = server()
    const again = useReportFeed({ endpoint: '/api/analytics/sessions', query: { lens: 'path', period: '30d' }, fetcher: second.fetcher })

    expect(second.fetcher).not.toHaveBeenCalled()
    expect(again.payload.value).toBe(feed.payload.value)
    expect(again.lens.value?.key).toBe('path')
  })

  it('cancels the request in flight when filters change, and waits out the debounce', async () => {
    const { calls, fetcher } = server()
    const query = ref<Record<string, unknown>>({ period: '30d', lens: 'path' })
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query, fetcher })

    query.value = { period: '7d', lens: 'path' }
    await nextTick()
    expect(calls[0].signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(299)
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(calls[1].query.period).toBe('7d')

    // The abandoned answer, arriving late, changes nothing.
    await answer(calls[0])
    expect(feed.payload.value).toBeNull()

    await answer(calls[1])
    expect(feed.payload.value?.lens?.key).toBe('path')
  })

  it('makes one request for a burst of quick changes', async () => {
    const { fetcher } = server()
    const query = ref<Record<string, unknown>>({ period: '30d', lens: 'path' })
    useReportFeed({ endpoint: '/api/analytics/sessions', query, fetcher })

    for (const period of ['7d', '90d', '12m']) {
      query.value = { period, lens: 'path' }
      await nextTick()
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(300)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].period).toBe('12m')
  })

  it('switches lens at once, only the lens waiting, then back from memory', async () => {
    const { calls, fetcher } = server()
    const query = ref<Record<string, unknown>>({ period: '30d', lens: 'path' })
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query, fetcher })
    await answer(calls[0])

    query.value = { period: '30d', lens: 'dropoff' }
    await nextTick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(feed.lensLoading.value).toBe(true)
    expect(feed.refreshing.value).toBe(false)
    expect(feed.lens.value).toBeNull()
    expect(feed.payload.value?.kpis).toHaveLength(1)

    await answer(calls[1])
    expect(feed.lens.value?.key).toBe('dropoff')
    expect(feed.lensLoading.value).toBe(false)

    query.value = { period: '30d', lens: 'path' }
    await nextTick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(feed.lens.value?.key).toBe('path')
  })

  it('never calls the server to switch a metric: every metric is in the answer', async () => {
    const { calls, fetcher } = server()
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query: { period: '30d', lens: 'peak' }, fetcher })
    await answer(calls[0])

    const visual = feed.lens.value!.visual!
    expect(visual.metrics.map(metric => metric.key)).toEqual(['sessions', 'started_at'])
    expect(Object.keys(visual.data)).toEqual(['sessions', 'started_at'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('dims the page while other filters load, and keeps what it shows', async () => {
    const { calls, fetcher } = server()
    const query = ref<Record<string, unknown>>({ period: '30d', lens: 'path' })
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query, fetcher })
    await answer(calls[0])

    query.value = { period: '7d', lens: 'path' }
    await nextTick()
    expect(feed.refreshing.value).toBe(true)
    expect(feed.payload.value?.page).toBe('sessions')
  })

  it('says why it failed, and tries again when asked', async () => {
    const { calls, fetcher } = server()
    const feed = useReportFeed({ endpoint: '/api/analytics/sessions', query: { period: '30d', lens: 'path' }, fetcher })

    calls[0].reject(new Error('الفترة المخصّصة أطول من المدة المسموح بها.'))
    await flush()
    expect(feed.error.value).toBe('الفترة المخصّصة أطول من المدة المسموح بها.')
    expect(feed.payload.value).toBeNull()

    feed.retry()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await answer(calls[1])
    expect(feed.error.value).toBeNull()
    expect(feed.payload.value?.page).toBe('sessions')
  })
})
