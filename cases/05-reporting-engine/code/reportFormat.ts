import useNumberFormat from '~/composables/useNumberFormat'
import usePriceFormat from '~/composables/usePriceFormat'

/**
 * How the console writes a figure. A number and a sum of money go through the
 * same formatters the rest of the admin uses, so a report can never disagree
 * with the card beside it on a single digit; a date is written in those same
 * digits again. A right-to-left reader sees exactly two kinds of text built
 * out of numbers — a figure with a sign, and a count with a noun — and both of
 * them have a right and a wrong way to sit in the line.
 */

export type Translate = (key: string, params?: Record<string, unknown>) => string

export type ValueFormat =
  | 'int'
  | 'decimal'
  | 'money'
  | 'pct'
  | 'points'
  | 'hours'
  | 'minutes'
  | 'days'
  | 'text'

export type PeriodKey = 'today' | '7d' | '30d' | '90d' | '12m' | 'month' | 'year' | 'custom' | 'all'

/** What an absent value looks like; never a zero. */
export const EMPTY_VALUE = '-'

/**
 * Left-to-right isolate and pop. A signed number, a percentage, an axis tick
 * are runs of left-to-right characters: dropped into a right-to-left sentence
 * unisolated, the sign migrates to the wrong end of the run and «-12.9%» reads
 * as if the percent were subtracted. The two characters are invisible, so
 * wrapping a value costs a copy-paste nothing.
 */
const LRI = '\u2066'
const PDI = '\u2069'

export const isolate = (text: string): string => `${LRI}${text}${PDI}`

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const isBlank = (value: unknown): boolean => value === null || value === undefined || value === ''

const toNumber = (value: unknown): number | null => {
  if (isBlank(value))
    return null
  const number = Number(value)

  return Number.isFinite(number) ? number : null
}

/** The digits the console writes: whichever system the browser's own locale resolves to. */
export const numberingSystem = (): string => new Intl.NumberFormat().resolvedOptions().numberingSystem

/** A number the way the shared formatter writes it (at most two decimals). */
export const formatNumber = (value: number): string => useNumberFormat(value)

/** Money as plain text — an axis label, a canvas summary — the shared digits, without the currency icon. */
export const formatMoneyText = (value: number): string => usePriceFormat(value).replace(/<[^>]*>/g, '').trim()

export type UnitFormat = 'points' | 'hours' | 'minutes' | 'days'

/** The `Intl` unit behind each duration; `points` has none, handled on its own. */
const UNIT_NOUNS: Record<Exclude<UnitFormat, 'points'>, 'day' | 'hour' | 'minute'> = {
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
}

/** The locale the units are written in, taken from the locale files so a unit is in the language of the sentence around it. */
const unitLocale = (t: Translate): string => {
  const tag = t('reports.units.locale')
  try {
    return Intl.NumberFormat.supportedLocalesOf(tag).length ? tag : 'en'
  }
  catch {
    return 'en'
  }
}

/**
 * This console's Arabic writes the tanween after the alef («يوماً»), in its
 * locale files and in every sentence the API sends; `Intl` writes it before
 * the alef («يومًا»). Every string that comes out of `Intl` is brought back to
 * the console's spelling, so one screen never shows two spellings of one word.
 */
const normalizePresentation = (text: string): string => text.replace(/ًا/g, 'اً')

/**
 * The one way a count is written with its unit, the unit agreeing with the
 * count: «يوم، يومان، 3 أيام، 11 يوماً، 19.1 يوم», "1 day, 2 days". Days, hours
 * and minutes are this console's own units and `Intl` writes them out; points
 * have no `Intl` unit, so their forms live in `reports.units.points`, one per
 * plural category. An age (`ago`) is relative time, which inflects the noun
 * after «قبل» («قبل يومين»). Latin digits throughout, as everywhere here.
 */
export function formatUnit(value: number, unit: UnitFormat, t: Translate, when?: 'ago'): string {
  const locale = unitLocale(t)

  if (unit === 'points') {
    const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
    const category = new Intl.PluralRules(locale, { maximumFractionDigits: 2 }).select(value)

    return t(`reports.units.points.${category}`, { count })
  }

  if (when === 'ago')
    return normalizePresentation(new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-value, UNIT_NOUNS[unit]))

  // Exactly one: `Intl` writes the bare noun («يوم»), which reads as a lost
  // figure beside an unrelated label; «يوم واحد» reads whole inside a sentence.
  if (new Intl.PluralRules(locale, { maximumFractionDigits: 1 }).select(value) === 'one')
    return t(`reports.units.one.${unit}`)

  return normalizePresentation(new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNIT_NOUNS[unit],
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(value))
}

/** A figure as plain text, for canvas labels and screen-reader sentences. `null` is the empty mark. */
export function formatPlain(value: unknown, format: ValueFormat, t: Translate): string {
  if (format === 'text')
    return isBlank(value) ? EMPTY_VALUE : String(value)

  const number = toNumber(value)
  if (number === null)
    return EMPTY_VALUE

  switch (format) {
  case 'money': return formatMoneyText(number)
  case 'pct': return `${formatNumber(number)}%`
  case 'points':
  case 'hours':
  case 'minutes':
  case 'days':
    return formatUnit(number, format, t)
  default: return formatNumber(number)
  }
}

/** A figure as HTML, for cards, tables and tooltips: money keeps its currency icon. Text is escaped. */
export function formatHtml(value: unknown, format: ValueFormat, t: Translate): string {
  if (format === 'money') {
    const number = toNumber(value)

    return number === null ? EMPTY_VALUE : usePriceFormat(number)
  }

  return escapeHtml(formatPlain(value, format, t))
}

/** A percentage change with its sign, for text: `+12.9%`, `-3.1%`, `0%`. */
export function formatChange(value: number): string {
  const sign = value > 0 ? '+' : (value < 0 ? '-' : '')

  return `${sign}${formatNumber(Math.abs(value))}%`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/

const dateFormat = (locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, numberingSystem: numberingSystem(), timeZone: 'UTC' })

/** `YYYY-MM-DD` as a readable date (`29 Sep 2026`); anything else comes back as it arrived. */
export function formatDate(value: string | null | undefined, locale: string, withYear = true): string {
  const match = value ? DATE_RE.exec(value) : null
  if (!match)
    return value || EMPTY_VALUE

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))

  return dateFormat(locale, withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }).format(date)
}

/** `YYYY-MM` as a month and its year (`September 2026`). */
export function formatMonth(value: string | null | undefined, locale: string, short = false): string {
  const match = value ? MONTH_RE.exec(value) : null
  if (!match)
    return value || EMPTY_VALUE

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))

  return dateFormat(locale, { month: short ? 'short' : 'long', year: 'numeric' }).format(date)
}

/** A year in the digits of the rest of the page, with no thousands separator. */
export const formatYear = (value: string | number): string =>
  new Intl.NumberFormat(undefined, { useGrouping: false }).format(Number(value))

/** A timestamp (`generated_at`) as a short time of day. */
export function formatTime(value: string | null | undefined, locale: string): string {
  const time = value ? Date.parse(value) : Number.NaN
  if (Number.isNaN(time))
    return EMPTY_VALUE

  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', numberingSystem: numberingSystem() }).format(new Date(time))
}

/** Whether chart categories are a time axis: every one a date or a month. */
export const isTimeAxis = (categories: string[]): boolean =>
  categories.length > 0 && categories.every(category => DATE_RE.test(category) || MONTH_RE.test(category))

/** A category of a time axis, shortened: a day and its month, or a month and its year. */
export function formatCategory(value: string, locale: string): string {
  if (DATE_RE.test(value))
    return formatDate(value, locale, false)
  if (MONTH_RE.test(value))
    return formatMonth(value, locale, true)

  return value
}

export interface PeriodChoice {
  period: PeriodKey
  month?: string | null
  year?: string | null
  date_from?: string | null
  date_to?: string | null
}

/** A period in words: `Last 30 days`, `September 2026`, `2026`, `29 Aug 2026 to 27 Sep 2026`. */
export function periodLabel(choice: PeriodChoice, t: Translate, locale: string): string {
  switch (choice.period) {
  case 'month': return choice.month ? formatMonth(choice.month, locale) : t('reports.periods.month')
  case 'year': return choice.year ? formatYear(choice.year) : t('reports.periods.year')
  case 'custom':
    return choice.date_from && choice.date_to
      ? t('reports.periods.range', { from: formatDate(choice.date_from, locale), to: formatDate(choice.date_to, locale) })
      : t('reports.periods.custom')
  default: return t(`reports.periods.${choice.period}`)
  }
}
