import { wholePercent, type Ratio } from './period-change'
import type { TimeZone } from './time-range'

/**
 * A number a page could compute, or the reason it could not. v2 shows the reason with
 * "Not available", never a 0 (SHL-FR-17).
 */
export type Reading<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: string }

export const NOT_AVAILABLE = 'Not available'

/**
 * The server and the browser must format alike, or hydration fails. Pages pass the viewer's
 * locale when they know it. The default is the locale the classic studio writes in.
 */
const DEFAULT_LOCALE = 'en-US'

export function formatCount(value: number, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/** A count that is a difference, such as the change in entries: `+1,204`, `-890`, `0`. */
export function formatSignedCount(value: number, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(value)
}

/** A rate as a whole percent, or `null` when it has nothing to divide. */
export function formatRate(ratio: Ratio): string | null {
  const percent = wholePercent(ratio)
  return percent === null ? null : `${percent}%`
}

const DURATION_UNITS = [
  { label: 'd', ms: 86_400_000 },
  { label: 'h', ms: 3_600_000 },
  { label: 'min', ms: 60_000 },
  { label: 's', ms: 1_000 },
] as const

/**
 * The largest two units that apply, truncated: `4 min 12 s`, `2 h 5 min`. A zero second unit is
 * left out, so 2 hours reads `2 h`. Under a second reads `< 1 s`.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 s'
  if (ms < 1_000) return '< 1 s'
  const first = DURATION_UNITS.findIndex((unit) => ms >= unit.ms)
  const parts: string[] = []
  let rest = ms
  for (const unit of DURATION_UNITS.slice(first, first + 2)) {
    const amount = Math.floor(rest / unit.ms)
    rest -= amount * unit.ms
    if (amount > 0) parts.push(`${amount} ${unit.label}`)
  }
  return parts.join(' ')
}

export function formatDateTime(instant: number, zone: TimeZone, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(instant)
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * A time within the last 24 hours reads relative to `now`, such as "12 min ago". An older one
 * reads as its date and time in the viewer's zone. `exact` is the date and time for the hover.
 */
export function formatTimestamp(
  instant: number,
  now: number,
  zone: TimeZone,
  locale: string = DEFAULT_LOCALE,
): { text: string; exact: string } {
  const exact = formatDateTime(instant, zone, locale)
  const age = now - instant
  if (age >= DAY_MS) return { text: exact, exact }
  if (age < MINUTE_MS) return { text: 'just now', exact }
  if (age < HOUR_MS) return { text: `${Math.floor(age / MINUTE_MS)} min ago`, exact }
  return { text: `${Math.floor(age / HOUR_MS)} h ago`, exact }
}
