import type { EChartsOption } from 'echarts'
import type { ValueFormat } from './reportFormat'
import { escapeHtml, formatHtml, formatNumber, isolate } from './reportFormat'

/**
 * What every report chart shares: the palettes, the chrome, the axes, the
 * legend and the tooltip. The builders beside this section are pure — the
 * contract's visual in, ECharts options out, `null` when there is nothing to
 * draw, and the chart component shows its empty state instead. A builder never
 * touches the network, the DOM, or a store, which is what makes the visual
 * layer worth unit-testing.
 */

export interface ChartContext {
  rtl: boolean
  dark: boolean

  /** The interface language (`ar`, `en`), for dates and plural forms. */
  locale: string
  t: (key: string, params?: Record<string, unknown>) => string
}

type Mode = 'light' | 'dark'

const mode = (context: ChartContext): Mode => (context.dark ? 'dark' : 'light')

/**
 * Series colours, in a fixed order that is never cycled. Each is the second
 * step of a hue family, far enough from its neighbours to carry identity on
 * its own. The five were checked against the card surface of each mode for
 * lightness, a chroma floor, separation under colour-vision deficiency (the
 * worst adjacent pair 16.1 light / 14.6 dark) and contrast (all at least 3:1);
 * a sixth series folds into the neutral instead of inventing a hue.
 */
export const SERIES_COLORS: Record<Mode, readonly string[]> = {
  light: ['#9c5a3c', '#2b7f9e', '#ab8140', '#6a74b0', '#5f8748'],
  dark: ['#b06d4b', '#3190b3', '#b98d49', '#727cba', '#698f52'],
}

export const OTHER_COLOR: Record<Mode, string> = { light: '#9a8f88', dark: '#8d93a8' }

export interface Chrome {
  surface: string
  ink: string
  secondary: string
  muted: string
  grid: string
  axis: string
  wash: string
}

export const CHROME: Record<Mode, Chrome> = {
  light: {
    surface: '#ffffff',
    ink: '#2c2724',
    secondary: '#5c554f',
    muted: '#7d756e',
    grid: '#e7e2de',
    axis: '#d3ccc7',
    wash: 'rgba(156, 90, 60, 0.10)',
  },
  dark: {
    surface: '#1c1b22',
    ink: '#eceaf2',
    secondary: 'rgba(219, 221, 238, 0.78)',
    muted: 'rgba(219, 221, 238, 0.6)',
    grid: 'rgba(219, 221, 238, 0.12)',
    axis: 'rgba(219, 221, 238, 0.24)',
    wash: 'rgba(219, 221, 238, 0.08)',
  },
}

export const chrome = (context: ChartContext): Chrome => CHROME[mode(context)]

/**
 * The colour of each series key of a visual. It follows the entity, not its
 * rank: a key keeps its colour when the metric changes, in the order the keys
 * first appear.
 */
export function seriesColorMap(visual: { data: Record<string, { series?: Array<{ key: string }> } | undefined> }, context: ChartContext): Map<string, string> {
  const colors = new Map<string, string>()
  const palette = SERIES_COLORS[mode(context)]

  for (const data of Object.values(visual.data)) {
    for (const series of data?.series ?? []) {
      if (!colors.has(series.key))
        colors.set(series.key, palette[colors.size] ?? OTHER_COLOR[mode(context)])
    }
  }

  return colors
}

export const seriesColor = (index: number, context: ChartContext): string =>
  SERIES_COLORS[mode(context)][index] ?? OTHER_COLOR[mode(context)]

export interface VisualMetric {
  key: string
  label: string
  format: ValueFormat
  finance: boolean
}

interface VisualBase {
  metric: string
  metrics: VisualMetric[]
  data: Record<string, unknown>
  note: string | null
}

/** The metric a visual shows, falling back to the first when the key is unknown. */
export function metricOf(visual: VisualBase, key: string): VisualMetric {
  return visual.metrics.find(metric => metric.key === key)
    ?? visual.metrics[0]
    ?? { key, label: '', format: 'int', finance: false }
}

/** The key whose data is drawn: the asked one when it has data, otherwise the visual's own. */
export function metricKeyOf(visual: VisualBase, key: string | null | undefined): string {
  if (key && visual.data[key] !== undefined)
    return key

  return visual.data[visual.metric] !== undefined ? visual.metric : (Object.keys(visual.data)[0] ?? visual.metric)
}

/** An axis tick: plain digits, isolated so a sign stays in front in right-to-left text, with no unit. */
export function axisValue(value: number, format: ValueFormat): string {
  const text = format === 'pct' ? `${formatNumber(value)}%` : formatNumber(value)

  return isolate(text)
}

export function baseOption() {
  return {
    backgroundColor: 'transparent',
    animationDuration: 400,
    animationDurationUpdate: 300,
  }
}

export function legendOption(context: ChartContext, show: boolean, icon?: string) {
  return {
    show,
    type: 'scroll' as const,
    top: 0,
    [context.rtl ? 'right' : 'left']: 0,
    align: (context.rtl ? 'right' : 'left') as 'right' | 'left',
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 16,
    icon,
    textStyle: { color: chrome(context).secondary, fontSize: 12 },
  }
}

export function tooltipOption(context: ChartContext) {
  const colors = chrome(context)

  return {
    confine: true,
    appendToBody: true,
    backgroundColor: context.dark ? '#111018' : colors.surface,
    borderColor: colors.grid,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: colors.ink, fontSize: 13 },
    extraCssText: `border-radius: 8px; box-shadow: 0 4px 16px rgba(16, 24, 40, 0.12); direction: ${context.rtl ? 'rtl' : 'ltr'}; text-align: start;`,
  }
}

/** The heading of a tooltip. Labels come from the server: always escaped. */
export const tooltipTitle = (text: string): string =>
  `<div style="font-weight: 600; margin-block-end: 4px;">${escapeHtml(text)}</div>`

/**
 * One line of a tooltip: the value leads, the label follows, keyed by a short
 * stroke of the series colour — a line, not a box, so it reads the same in
 * either direction.
 */
export function tooltipRow(context: ChartContext, valueHtml: string, label: string, color: string | null = null): string {
  const key = color
    ? `<span style="display: inline-block; inline-size: 12px; block-size: 2px; border-radius: 1px; background: ${color};"></span>`
    : ''

  return `<div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;">${key}<strong>${valueHtml}</strong><span style="color: ${chrome(context).muted};">${escapeHtml(label)}</span></div>`
}

/** A value for a tooltip, as HTML (money with its icon). */
export const tooltipValue = (value: unknown, format: ValueFormat, context: ChartContext): string =>
  formatHtml(value, format, context.t)

/* ------------------------------------------------------------------ *
 * The coverage builder.
 *
 * A scatter cut into four named quarters by two split lines. Every point wears
 * the same colour: its position already says which quarter it lies in, so a
 * colour per quarter would only repeat that. The quarters are named in their
 * outer corners with the number of points each holds, and a point's size is
 * its value — its area, not its radius, so the eye compares areas. An entity
 * without a score has no place on the chart at all; the unplaced are counted
 * in one line under it instead of being dropped silently.
 * ------------------------------------------------------------------ */

/** The entry of the entities without a score: counted, never drawn. */
const UNPLACED = 'unplaced'

// The one coverage chart plots a satisfaction score; a second scale would need
// its bounds carried in the payload rather than hard-coded here.
const SCORE_AXIS = { min: 0, max: 5, interval: 1 }

export interface CoveragePoint {
  id: number | string
  label: string
  x: number
  y: number
  size: number
  band: string
}

export interface CoverageBand {
  key: string
  label: string
  count: number
}

export interface CoverageData {
  x_label: string
  y_label: string
  x_split: number
  y_split: number
  points: CoveragePoint[]
  bands: CoverageBand[]
}

export interface CoverageVisual extends VisualBase {
  type: 'coverage'
  variant: null
  data: Record<string, CoverageData>
}

/** The points the chart can place: both coordinates known. */
const placed = (data: CoverageData) => data.points.filter(point => typeof point.x === 'number' && typeof point.y === 'number')

export const hasCoverageData = (data: CoverageData | null | undefined): data is CoverageData =>
  !!data && Array.isArray(data.points) && placed(data).length > 0

/** The four quarters named in the corners. */
const corners = (data: CoverageData) => data.bands.filter(band => band.key !== UNPLACED)

export interface CoverageSide {
  highX: boolean
  highY: boolean
}

/** The order the quarters are assumed to come in when one of them holds no point. */
const DEFAULT_SIDES: CoverageSide[] = [
  { highX: true, highY: true },
  { highX: false, highY: true },
  { highX: true, highY: false },
  { highX: false, highY: false },
]

/** Where each quarter lies: read from one of its own points, or from its place in the list. */
export function coverageSides(data: CoverageData): Map<string, CoverageSide> {
  const sides = new Map<string, CoverageSide>()
  data.bands.forEach((band, index) => {
    const point = data.points.find(entry => entry.band === band.key)
    sides.set(band.key, point
      ? { highX: point.x >= data.x_split, highY: point.y >= data.y_split }
      : DEFAULT_SIDES[index] ?? DEFAULT_SIDES[3])
  })

  return sides
}

/** Axis bounds that hold every point and the split, rounded outward to a tidy step. */
export function niceBounds(values: number[]): [number, number] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || Math.abs(max) || 1
  const step = 10 ** Math.floor(Math.log10(span)) / 2

  return [Math.floor((min - span * 0.05) / step) * step, Math.ceil((max + span * 0.05) / step) * step]
}

const MIN_SIZE = 12
const MAX_SIZE = 32

export function coverageOptions(visual: CoverageVisual, metricKey: string, context: ChartContext): EChartsOption | null {
  const key = metricKeyOf(visual, metricKey)
  const data = visual.data[key]
  if (!hasCoverageData(data))
    return null

  const metric = metricOf(visual, key)
  const ink = chrome(context)
  const points = placed(data)

  // A rate is never below zero: hold the axis from 0 to a tidy figure above
  // the largest point and the split.
  const xMin = 0
  const xMax = niceBounds([0, ...points.map(point => point.x), data.x_split])[1]
  const { min: yMin, max: yMax } = SCORE_AXIS
  const largest = Math.max(0, ...points.map(point => point.size || 0))
  const sides = coverageSides({ ...data, points, bands: corners(data) })

  const area = (band: CoverageData['bands'][number]) => {
    const side = sides.get(band.key) as CoverageSide
    // A quarter named on the right is the one the reading direction puts last.
    const onRight = side.highX !== context.rtl
    const position = `inside${side.highY ? 'Top' : 'Bottom'}${onRight ? 'Right' : 'Left'}`

    return [
      {
        name: `${band.label} · ${formatNumber(band.count)}`,
        xAxis: side.highX ? data.x_split : xMin,
        yAxis: side.highY ? data.y_split : yMin,
        label: { position },
      },
      { xAxis: side.highX ? xMax : data.x_split, yAxis: side.highY ? yMax : data.y_split },
    ]
  }

  const axis = { axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: ink.grid } } }

  return {
    ...baseOption(),

    // Room above the plot for the level name of the score axis.
    grid: { top: 36, bottom: 36, left: 16, right: 16, containLabel: true },
    tooltip: {
      ...tooltipOption(context),
      trigger: 'item',
      formatter: (params: unknown) => {
        const index = (params as { dataIndex?: number })?.dataIndex ?? -1
        const point = points[index]
        if (!point)
          return ''
        const band = data.bands.find(entry => entry.key === point.band)

        return tooltipTitle(point.label)
          + tooltipRow(context, formatNumber(point.x), data.x_label)
          + tooltipRow(context, formatNumber(point.y), data.y_label)
          + tooltipRow(context, formatHtml(point.size, metric.format, context.t), metric.label)
          + (band ? tooltipRow(context, '', band.label) : '')
      },
    },
    xAxis: {
      type: 'value',
      name: data.x_label,
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: ink.secondary, fontSize: 12 },
      min: xMin,
      max: xMax,
      inverse: context.rtl,
      axisLabel: { color: ink.muted, fontSize: 12, formatter: (value: number) => formatNumber(value) },
      ...axis,
    },
    yAxis: {
      type: 'value',
      name: data.y_label,

      // Level above the axis, running into the chart: turned at the edge of the canvas it was cut.
      nameLocation: 'end',
      nameGap: 12,
      nameTextStyle: { color: ink.secondary, fontSize: 12, align: context.rtl ? 'right' : 'left' },
      min: yMin,
      max: yMax,
      interval: SCORE_AXIS.interval,
      position: context.rtl ? 'right' : 'left',
      axisLabel: { color: ink.muted, fontSize: 12, formatter: (value: number) => formatNumber(value) },
      ...axis,
    },
    series: [{
      type: 'scatter',
      name: metric.label,
      data: points.map(point => ({ value: [point.x, point.y, point.size || 0], name: point.label })),
      symbolSize: (value: number[]) => (largest ? MIN_SIZE + (MAX_SIZE - MIN_SIZE) * Math.sqrt((value[2] || 0) / largest) : MIN_SIZE),
      itemStyle: { color: seriesColor(0, context), opacity: 0.8, borderColor: ink.surface, borderWidth: 2 },
      emphasis: { itemStyle: { opacity: 1 } },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },

        // Thresholds, not grid: dashed says so.
        lineStyle: { color: ink.muted, type: 'dashed', width: 1 },
        data: [{ xAxis: data.x_split }, { yAxis: data.y_split }],
      },
      markArea: {
        silent: true,
        itemStyle: { color: 'transparent' },
        label: { color: ink.secondary, fontSize: 12, fontWeight: 600 },
        data: corners(data).map(area),
      },
    }],
  } as EChartsOption
}

export const coverageHeight = (): number => 400

/** The line under the chart: how many entities have no score, and so are not drawn; `null` when none is. */
export function coverageNote(visual: CoverageVisual, metricKey: string, context: ChartContext): string | null {
  const unplaced = visual.data[metricKeyOf(visual, metricKey)]?.bands?.find(band => band.key === UNPLACED)

  return unplaced?.count ? context.t('reports.visual.coverage.unplaced', { label: unplaced.label, count: formatNumber(unplaced.count) }) : null
}

/** The sentence a screen reader gets in place of the canvas. */
export function describeCoverage(visual: CoverageVisual, metricKey: string, context: ChartContext): string {
  const data = visual.data[metricKeyOf(visual, metricKey)]
  if (!hasCoverageData(data))
    return context.t('reports.visual.empty')

  return context.t('reports.visual.summary.coverage', {
    count: formatNumber(placed(data).length),
    list: corners(data).map(band => `${band.label} ${formatNumber(band.count)}`).join(context.t('reports.visual.separator')),
  })
}
