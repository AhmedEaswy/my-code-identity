import { defineAsyncComponent, type Component } from 'vue'

/**
 * The dashboard's shape as data: its pages, and the sections each page shows in
 * grid order. The sidebar, the tabs and the route guard all read this list, so
 * this half imports no component — a section's component is resolved lazily,
 * from the file system, in the half below.
 *
 * A page is a row here; a section's view is a file named after its kind. That
 * is the whole contract: add a row to open a page, add a file to give a kind a
 * view, and neither the router nor the sidebar changes.
 */

export type DashboardFamily = 'overview' | 'operations' | 'finance' | 'growth' | 'quality'

export type DashboardKind =
  | 'status' | 'kpi' | 'verdicts' | 'targets' | 'alerts' | 'equation'
  | 'income' | 'funnel' | 'timeline' | 'heatmap' | 'cohorts' | 'map'
  | 'treemap' | 'waterfall' | 'flow' | 'bars' | 'mix' | 'matrix'
  | 'aging' | 'quadrants' | 'range' | 'line' | 'table' | 'guide'

export type DashboardSize = 'tile' | 'normal' | 'primary'

export interface DashboardSectionDef {
  key: string
  kind: DashboardKind
  size: DashboardSize
  cols: 3 | 4 | 6 | 8 | 9 | 12
  mobile?: 'stack' | 'row'
  hasFull: boolean
  deferred?: boolean
  params?: readonly string[]
}

export interface DashboardPageDef {
  key: string
  permission: string
  icon: string
  family: DashboardFamily
  kind: 'page' | 'tool'
  sections: readonly DashboardSectionDef[]
}

export const KINDS: readonly DashboardKind[] = [
  'status', 'kpi', 'verdicts', 'targets', 'alerts', 'equation',
  'income', 'funnel', 'timeline', 'heatmap', 'cohorts', 'map',
  'treemap', 'waterfall', 'flow', 'bars', 'mix', 'matrix',
  'aging', 'quadrants', 'range', 'line', 'table', 'guide',
]

/** Kinds whose card opens another screen instead of a full view of its own. */
export const WITHOUT_FULL: readonly DashboardKind[] = ['status', 'alerts', 'equation', 'guide']

const section = (
  key: string,
  kind: DashboardKind,
  size: DashboardSize,
  cols: DashboardSectionDef['cols'],
  extra: Partial<DashboardSectionDef> = {},
): DashboardSectionDef => ({ key, kind, size, cols, hasFull: !WITHOUT_FULL.includes(kind), ...extra })

export const PAGES: readonly DashboardPageDef[] = [
  {
    key: 'overview',
    permission: 'dashboard.view_overview',
    icon: 'tabler-layout-dashboard',
    family: 'overview',
    kind: 'page',
    sections: [
      section('status', 'status', 'tile', 12),
      section('kpis', 'kpi', 'primary', 12, { params: ['metric', 'granularity'] }),
      section('targets', 'targets', 'primary', 8),
      section('anomalies', 'verdicts', 'normal', 4),
      section('alerts', 'alerts', 'primary', 8, { deferred: true }),
    ],
  },
  {
    key: 'operations',
    permission: 'dashboard.view_operations',
    icon: 'tabler-settings-check',
    family: 'operations',
    kind: 'page',
    sections: [
      section('throughput', 'bars', 'primary', 12),
      section('readiness', 'matrix', 'normal', 8),
      section('concentration', 'mix', 'normal', 4, { params: ['metric'] }),
      section('activity', 'heatmap', 'primary', 12),
    ],
  },
  {
    key: 'finance',
    permission: 'dashboard.view_finance',
    icon: 'tabler-coins',
    family: 'finance',
    kind: 'page',
    sections: [
      section('equation', 'equation', 'primary', 12),
      section('income', 'income', 'primary', 8, { params: ['basis'] }),
      section('unit', 'waterfall', 'normal', 4),
      section('flow', 'flow', 'primary', 12, { params: ['basis'] }),
      section('aging', 'aging', 'normal', 6),
      section('guide', 'guide', 'normal', 12),
    ],
  },
  {
    key: 'growth',
    permission: 'dashboard.view_growth',
    icon: 'tabler-users-group',
    family: 'growth',
    kind: 'page',
    sections: [
      section('activation', 'funnel', 'primary', 8),
      section('segments', 'treemap', 'normal', 4),
      section('retention', 'cohorts', 'primary', 12, { params: ['metric'] }),
      section('campaigns', 'bars', 'normal', 6),
    ],
  },
  {
    key: 'quality',
    permission: 'dashboard.view_quality',
    icon: 'tabler-star',
    family: 'quality',
    kind: 'page',
    sections: [
      section('ratings', 'bars', 'primary', 8),
      section('watchlist', 'table', 'primary', 12),
      section('aging', 'aging', 'normal', 6),
      section('incentives', 'line', 'normal', 9),
    ],
  },
]

export const FAMILY_ICONS: Record<DashboardFamily, string> = {
  overview: 'tabler-layout-dashboard',
  operations: 'tabler-settings-check',
  finance: 'tabler-coins',
  growth: 'tabler-trending-up',
  quality: 'tabler-star',
}

/** Every page permission: holding any of them shows the dashboard's sidebar block. */
export const DASHBOARD_PERMISSIONS: readonly string[] = PAGES.map(page => page.permission)

export const TOOL_ROUTE = 'dashboard_tool'

export const pageByKey = (key: unknown): DashboardPageDef | undefined => PAGES.find(page => page.key === key)

export const sectionDef = (page: unknown, key: unknown): DashboardSectionDef | undefined =>
  pageByKey(page)?.sections.find(entry => entry.key === key)

/** The pages an account may open, in tab order. */
export const visiblePages = (can: (permission: string) => boolean): DashboardPageDef[] => PAGES.filter(page => can(page.permission))

// --- Component resolution --------------------------------------------------

type Loader = () => Promise<Component>

/**
 * Every view file, loaded when first drawn. A glob rather than a map of imports,
 * because a map eager-imports every section the moment the registry is read,
 * which is on every route.
 */
const FILES = import.meta.glob('../components/dashboard/sections/*.vue') as Record<string, Loader>

const fileOf = (name: string): Loader | undefined => FILES[`../components/dashboard/sections/${name}.vue`]

/** `stage_line` to `StageLine`: the prefix both of a kind's files share. */
export const kindFileName = (kind: DashboardKind): string =>
  kind.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')

/**
 * A kind's two views as soon as their files exist, the pending pair until then,
 * so a kind is given its views by adding files. A kind without a full view
 * keeps `full: null`.
 */
export const KIND_COMPONENTS = Object.fromEntries(KINDS.map(kind => [kind, {
  summary: fileOf(`${kindFileName(kind)}Summary`) ?? fileOf('_PendingSummary')!,
  full: WITHOUT_FULL.includes(kind) ? null : (fileOf(`${kindFileName(kind)}Full`) ?? fileOf('_PendingFull')!),
}])) as Record<DashboardKind, { summary: Loader, full: Loader | null }>

const loaded = new Map<string, Component>()

/** The async component of a kind's view, made once and reused across renders. */
export const kindComponent = (kind: DashboardKind, view: 'summary' | 'full'): Component | null => {
  const loader = KIND_COMPONENTS[kind]?.[view]
  if (!loader)
    return null
  if (!loaded.has(`${kind}:${view}`))
    loaded.set(`${kind}:${view}`, defineAsyncComponent(loader))

  return loaded.get(`${kind}:${view}`)!
}
