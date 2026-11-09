import { computeRange, parseRange, RANGE_KEYS, rangeLabel, type RangeKey, type Span, type TimeZone } from '@/shared/lib/time-range'

export const ALL_TIME = 'all'

/** JBD-FR-20: the studio shell's ranges, and All time, which has no start. */
export type AnalyticsRange = RangeKey | typeof ALL_TIME

export const ANALYTICS_RANGES: readonly AnalyticsRange[] = [...RANGE_KEYS, ALL_TIME]

export function analyticsRangeLabel(range: AnalyticsRange): string {
  return range === ALL_TIME ? 'All time' : rangeLabel(range)
}

/** Reads `?range=` as the shell does, and also accepts `all`. */
export function parseAnalyticsRange(param: string | string[] | undefined): { range: AnalyticsRange; rewrite: boolean } {
  const value = Array.isArray(param) ? param[0] : param
  if (value === ALL_TIME) return { range: ALL_TIME, rewrite: false }
  const { key, rewrite } = parseRange(param)
  return { range: key, rewrite }
}

/** The span of event time the counts read, or null for All time. */
export function analyticsSpan(range: AnalyticsRange, now: number, zone: TimeZone): Span | null {
  return range === ALL_TIME ? null : computeRange(range, now, zone).current
}
