/**
 * CUS-FR-08: a person's metric values, computed as customer decision's metric functions compute
 * them with no window, at the series clock. Every bucket that starts at or before the clock counts.
 */

const FUNCTIONS = [
  'COUNT',
  'INACTION',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'MEDIAN',
  'DISTINCT_COUNT',
  'LATEST',
  'PRICE_DROP',
  'DIFF',
] as const

export type MetricFunction = (typeof FUNCTIONS)[number]

/** A missing or unknown function means COUNT, as customer decision reads it. */
export function parseMetricFunction(value: unknown): MetricFunction {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return (FUNCTIONS as readonly string[]).includes(upper) ? (upper as MetricFunction) : 'COUNT'
}

type Newest = { readonly eventId: string; readonly eventTime: number; readonly value: number }

export type Bucket = {
  readonly start: number
  readonly count: number
  readonly sum: number | null
  readonly valueCount: number | null
  readonly min: number | null
  readonly max: number | null
  readonly newest: readonly Newest[]
}

const SIZES = new Set(['MINUTE', 'HOUR', 'DAY'])

type JsonObject = { readonly [key: string]: unknown }

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseNewest(value: unknown): Newest[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!isJsonObject(item)) return []
    const eventTime = finite(item.eventTime)
    const number = finite(item.value)
    if (eventTime === null || number === null) return []
    return [{ eventId: typeof item.eventId === 'string' ? item.eventId : '', eventTime, value: number }]
  })
}

/**
 * Null when the series does not parse: not an array, or a bucket without a size, a start, or a
 * count. A bucket that lacks a field a function needs counts as empty for that function.
 */
export function parseBuckets(value: unknown): Bucket[] | null {
  if (!Array.isArray(value)) return null
  const buckets: Bucket[] = []
  for (const item of value) {
    if (!isJsonObject(item) || typeof item.size !== 'string' || !SIZES.has(item.size)) return null
    const start = finite(item.start)
    const count = finite(item.count)
    if (start === null || count === null) return null
    buckets.push({
      start,
      count,
      sum: finite(item.sum),
      valueCount: finite(item.valueCount),
      min: finite(item.min),
      max: finite(item.max),
      newest: parseNewest(item.newest),
    })
  }
  return buckets
}

export type MetricValue =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'no-value' }
  /** MEDIAN and DISTINCT_COUNT need the series' summaries decoded, which phase 1 does not do. */
  | { readonly kind: 'not-shown'; readonly occurrences: number }
  | { readonly kind: 'not-available' }

const NO_VALUE: MetricValue = { kind: 'no-value' }

function value(number: number): MetricValue {
  return { kind: 'value', value: number }
}

function total(numbers: readonly number[]): number {
  return numbers.reduce((sum, number) => sum + number, 0)
}

function present(numbers: readonly (number | null)[]): number[] {
  return numbers.filter((number): number is number => number !== null)
}

// On equal event times, the occurrence whose event id sorts last is the newer.
function newestFirst(a: Newest, b: Newest): number {
  return b.eventTime - a.eventTime || (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0)
}

export function metricValue(fn: MetricFunction, buckets: readonly Bucket[], seriesClock: number): MetricValue {
  const counted = buckets.filter((bucket) => bucket.start <= seriesClock)
  const occurrences = total(counted.map((bucket) => bucket.count))
  switch (fn) {
    case 'COUNT':
    case 'INACTION':
      return value(occurrences)
    case 'SUM':
      return value(total(present(counted.map((bucket) => bucket.sum))))
    case 'AVG': {
      const withValues = counted.filter((bucket) => bucket.sum !== null && bucket.valueCount !== null)
      const values = total(withValues.map((bucket) => bucket.valueCount ?? 0))
      return values > 0 ? value(total(withValues.map((bucket) => bucket.sum ?? 0)) / values) : NO_VALUE
    }
    case 'MIN': {
      const mins = present(counted.map((bucket) => bucket.min))
      return mins.length > 0 ? value(Math.min(...mins)) : NO_VALUE
    }
    case 'MAX': {
      const maxes = present(counted.map((bucket) => bucket.max))
      return maxes.length > 0 ? value(Math.max(...maxes)) : NO_VALUE
    }
    case 'MEDIAN':
    case 'DISTINCT_COUNT':
      return { kind: 'not-shown', occurrences }
    case 'LATEST':
    case 'PRICE_DROP':
    case 'DIFF': {
      const [newest, second] = counted.flatMap((bucket) => bucket.newest).sort(newestFirst)
      if (fn === 'LATEST') return newest === undefined ? NO_VALUE : value(newest.value)
      return newest === undefined || second === undefined ? NO_VALUE : value(second.value - newest.value)
    }
    default: {
      const exhaustive: never = fn
      return exhaustive
    }
  }
}

const of = (word: string) => (attribute: string | null) => (attribute === null ? word : `${word} of ${attribute}`)

// The function line's measure, in words a marketer reads, such as "total of order.total".
const MEASURES: Record<MetricFunction, (attribute: string | null) => string> = {
  COUNT: () => 'number of times',
  INACTION: () => 'number of times',
  SUM: of('total'),
  AVG: of('average'),
  MIN: of('smallest'),
  MAX: of('largest'),
  MEDIAN: of('median'),
  DISTINCT_COUNT: (attribute) => `number of different ${attribute ?? 'values'}`,
  LATEST: of('latest value'),
  PRICE_DROP: of('price drop'),
  DIFF: of('change'),
}

const RETENTION_UNITS = [
  { ms: 86_400_000, name: 'day' },
  { ms: 3_600_000, name: 'hour' },
  { ms: 60_000, name: 'minute' },
  { ms: 1_000, name: 'second' },
] as const

/** The largest unit that divides the retention exactly, such as "30 days" or "36 hours". */
export function retentionLabel(retentionMs: number): string {
  const unit = RETENTION_UNITS.find((candidate) => retentionMs >= candidate.ms && retentionMs % candidate.ms === 0)
  if (unit === undefined) return `${retentionMs} ms`
  const amount = retentionMs / unit.ms
  return `${amount} ${unit.name}${amount === 1 ? '' : 's'}`
}

/** CUS-FR-08: the three lines of a metric's label. */
export type MetricLabel = {
  /** The event's display name from the catalog, or its system name without one. */
  readonly event: string
  /** The function, the attribute when there is one, and the retention, such as "number of times, last 30 days". */
  readonly measure: string
  /** The system name with the function, such as "add_to_cart · COUNT". */
  readonly system: string
}

export function metricLabel(
  eventName: string,
  displayName: string | null,
  fn: MetricFunction,
  attribute: string | null,
  retentionMs: number,
): MetricLabel {
  return {
    event: displayName?.trim() || eventName,
    measure: `${MEASURES[fn](attribute)}, last ${retentionLabel(retentionMs)}`,
    system: `${eventName} · ${fn}`,
  }
}
