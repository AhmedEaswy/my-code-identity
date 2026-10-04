/**
 * The pages of the analytics console, as a single list. The sidebar, the route
 * guard and the generic report screen are all drawn from this list, so shipping
 * a page is adding an entry — never another screen component. The route guard
 * reads it on every navigation, so it stays data only: no imports, no logic
 * beyond lookups.
 *
 * Human-readable titles and the questions each page answers live in
 * `reports.pages.<key>` of the locale files; the lens names live in
 * `reports.lenses.<key>.<lens>`.
 */

export type ReportKey =
  | 'overview'
  | 'audience'
  | 'workspaces'
  | 'sessions'
  | 'revenue'
  | 'cohorts'
  | 'campaigns'
  | 'catalog'
  | 'quality'
  | 'inbox'

/** A page's own filter, by the name the API already uses for it. */
export type PageFilterKey = 'channel' | 'topic_id' | 'topic' | 'severity'

export interface ReportDefinition {
  key: ReportKey
  permission: string
  icon: string

  /** The variations of the page. Each one is a different cut of the same
   *  endpoint, so switching between them is switching a query parameter. */
  lenses: readonly string[]

  /** Filters this page adds to the common bar, by their API names. */
  filters: readonly PageFilterKey[]

  /** Whether the page is finished and may be linked to. */
  ready: boolean

  /** A report is read; a tool also writes (targets, the inbox). */
  kind: 'report' | 'tool'
}

/** The permissions of the `analytics` group, one per page plus three shared ones. */
export const ANALYTICS_PERMISSIONS = [
  'analytics.view_overview',
  'analytics.view_audience',
  'analytics.view_workspaces',
  'analytics.view_sessions',
  'analytics.view_revenue',
  'analytics.view_cohorts',
  'analytics.view_campaigns',
  'analytics.view_catalog',
  'analytics.view_quality',
  'analytics.view_inbox',
  'analytics.manage_targets',
  'analytics.manage_inbox',
  'analytics.export',
] as const

export const REPORTS: readonly ReportDefinition[] = [
  { key: 'overview', permission: 'analytics.view_overview', icon: 'tabler-pulse', lenses: ['trend'], filters: [], ready: true, kind: 'report' },
  { key: 'audience', permission: 'analytics.view_audience', icon: 'tabler-map-pin', lenses: ['comparison', 'gaps'], filters: [], ready: true, kind: 'report' },
  { key: 'workspaces', permission: 'analytics.view_workspaces', icon: 'tabler-building-store', lenses: ['performance', 'onboarding', 'readiness'], filters: [], ready: true, kind: 'report' },
  { key: 'sessions', permission: 'analytics.view_sessions', icon: 'tabler-calendar-stats', lenses: ['path', 'dropoff', 'peak'], filters: ['channel'], ready: true, kind: 'report' },
  { key: 'revenue', permission: 'analytics.view_revenue', icon: 'tabler-coins', lenses: ['gross', 'unit', 'dues'], filters: [], ready: true, kind: 'report' },
  { key: 'cohorts', permission: 'analytics.view_cohorts', icon: 'tabler-users-group', lenses: ['activation', 'retention', 'segments'], filters: [], ready: true, kind: 'report' },
  { key: 'campaigns', permission: 'analytics.view_campaigns', icon: 'tabler-speakerphone', lenses: ['promo', 'channels'], filters: [], ready: true, kind: 'report' },
  { key: 'catalog', permission: 'analytics.view_catalog', icon: 'tabler-category', lenses: ['demand', 'pricing', 'search'], filters: ['topic_id', 'channel'], ready: true, kind: 'report' },
  { key: 'quality', permission: 'analytics.view_quality', icon: 'tabler-star', lenses: ['ratings', 'support'], filters: [], ready: true, kind: 'report' },
  { key: 'inbox', permission: 'analytics.view_inbox', icon: 'tabler-checklist', lenses: [], filters: ['topic', 'severity'], ready: true, kind: 'tool' },
]

/** Unlocks the revenue page and every money figure on the others. */
export const MONEY_PERMISSION = 'analytics.view_revenue'
export const EXPORT_PERMISSION = 'analytics.export'

/** Route names of the generic report screen and the tool screen. */
export const REPORT_PAGE_ROUTE = 'analytics_report'
export const INBOX_ROUTE = 'analytics_inbox'

export const reportByKey = (key: unknown): ReportDefinition | undefined =>
  REPORTS.find(report => report.key === key)

/** The pages the current account may open, in sidebar order. */
export const visibleReports = (can: (permission: string) => boolean): ReportDefinition[] =>
  REPORTS.filter(report => can(report.permission))

export const reportRoute = (report: ReportDefinition) =>
  report.kind === 'tool'
    ? { name: INBOX_ROUTE }
    : { name: REPORT_PAGE_ROUTE, params: { page: report.key } }

export const reportPath = (report: ReportDefinition): string => `/analytics/${report.key}`
