export const RANGE_KEYS = ['today', '7d', '30d'] as const
export type RangeKey = (typeof RANGE_KEYS)[number]
export const DEFAULT_RANGE: RangeKey = '7d'

export const TZ_COOKIE = 'tz'

declare const timeZoneBrand: unique symbol
export type TimeZone = string & { readonly [timeZoneBrand]: true }
export const UTC = 'UTC' as TimeZone

/** `[start, end)` in epoch milliseconds. */
export type Span = { readonly start: number; readonly end: number }

export type TimeRange = {
  readonly key: RangeKey
  readonly zone: TimeZone
  readonly current: Span
  readonly previous: Span
}

export type Day = Span & { readonly date: string }

type RangeRule = { readonly label: string; readonly daysBack: number; readonly shiftDays: number }

const RANGE_RULES: Record<RangeKey, RangeRule> = {
  today: { label: 'Today', daysBack: 0, shiftDays: 1 },
  '7d': { label: 'Last 7 days', daysBack: 6, shiftDays: 7 },
  '30d': { label: 'Last 30 days', daysBack: 29, shiftDays: 30 },
}

export function rangeLabel(key: RangeKey): string {
  return RANGE_RULES[key].label
}

function isRangeKey(value: string): value is RangeKey {
  return (RANGE_KEYS as readonly string[]).includes(value)
}

/**
 * Reads `?range=`. A missing value means the default. An unknown value means the default too,
 * and `rewrite` tells the page to put the default back in the address.
 */
export function parseRange(param: string | string[] | undefined): { key: RangeKey; rewrite: boolean } {
  const value = Array.isArray(param) ? param[0] : param
  if (value === undefined) return { key: DEFAULT_RANGE, rewrite: false }
  if (isRangeKey(value)) return { key: value, rewrite: false }
  return { key: DEFAULT_RANGE, rewrite: true }
}

/**
 * Reads the `tz` cookie. Anything that is not an IANA zone the runtime knows falls back to UTC.
 * The zone keeps the browser's spelling, because ICU renames some zones to legacy aliases, such
 * as Asia/Ho_Chi_Minh to Asia/Saigon, and the range picker shows the name.
 */
export function parseTimeZone(value: string | undefined): TimeZone {
  if (!value || value.length > MAX_ZONE_LENGTH || !IANA_SHAPE.test(value)) return UTC
  return canonicalZone(value) === undefined ? UTC : (value as TimeZone)
}

const MAX_ZONE_LENGTH = 64
// Area/Location names, up to three segments, or a bare name such as UTC. Offsets such as +07:00,
// which newer runtimes accept, are not IANA names.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/

// The cookie is client input, and the runtime accepts any letter case and every alias. Formatters
// are cached by the zone the runtime resolves a spelling to, which bounds them to the zones it
// knows. The spelling-to-zone lookup is cleared when full, so odd spellings cannot grow it.
const MAX_SPELLINGS = 512
const canonicalBySpelling = new Map<string, string>()
const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function canonicalZone(spelling: string): string | undefined {
  const known = canonicalBySpelling.get(spelling)
  if (known !== undefined) return known
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: spelling,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  } catch {
    return undefined
  }
  const canonical = formatter.resolvedOptions().timeZone
  if (!partsFormatters.has(canonical)) partsFormatters.set(canonical, formatter)
  if (canonicalBySpelling.size >= MAX_SPELLINGS) canonicalBySpelling.clear()
  canonicalBySpelling.set(spelling, canonical)
  return canonical
}

/** How many formatters and spellings are cached, for tests of the bounds. */
export function zoneCacheSizes(): { formatters: number; spellings: number } {
  return { formatters: partsFormatters.size, spellings: canonicalBySpelling.size }
}

export function zoneLabel(zone: TimeZone): string {
  return `Times in ${zone}`
}

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number }

// A TimeZone came from parseTimeZone or is UTC, so the runtime knows it.
function partsFormatter(zone: TimeZone): Intl.DateTimeFormat {
  return partsFormatters.get(canonicalZone(zone)!)!
}

function wallTimeAt(instant: number, zone: TimeZone): WallTime {
  const fields: Record<string, number> = {}
  for (const part of partsFormatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
    ms: ((instant % 1000) + 1000) % 1000,
  }
}

function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms)
}

function offsetAt(instant: number, zone: TimeZone): number {
  return wallAsUtc(wallTimeAt(instant, zone)) - instant
}

const DAY_MS = 86_400_000

/**
 * The instant that shows `wall` in `zone`. A wall time that occurs twice resolves to the earlier
 * instant. A wall time skipped by a daylight saving jump moves forward by the jump, as
 * Temporal's "compatible" rule does.
 */
function instantOf(wall: WallTime, zone: TimeZone): number {
  const asUtc = wallAsUtc(wall)
  const before = asUtc - offsetAt(asUtc - DAY_MS, zone)
  const after = asUtc - offsetAt(asUtc + DAY_MS, zone)
  const matches = [before, after].filter((t) => wallAsUtc(wallTimeAt(t, zone)) === asUtc)
  return matches.length > 0 ? Math.min(...matches) : before
}

function addCalendarDays(wall: WallTime, days: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function midnight(wall: WallTime): WallTime {
  return { ...wall, hour: 0, minute: 0, second: 0, ms: 0 }
}

function shiftInstant(instant: number, days: number, zone: TimeZone): number {
  return instantOf(addCalendarDays(wallTimeAt(instant, zone), days), zone)
}

export function computeRange(key: RangeKey, now: number, zone: TimeZone): TimeRange {
  const rule = RANGE_RULES[key]
  const today = wallTimeAt(now, zone)
  const current = { start: instantOf(midnight(addCalendarDays(today, -rule.daysBack)), zone), end: now }
  const previous = {
    start: shiftInstant(current.start, -rule.shiftDays, zone),
    end: shiftInstant(current.end, -rule.shiftDays, zone),
  }
  return { key, zone, current, previous }
}

function isoDate(wall: WallTime): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0')
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`
}

/** Splits a span into the calendar days of `zone` it touches, each clipped to the span. */
export function splitIntoDays(span: Span, zone: TimeZone): Day[] {
  const days: Day[] = []
  let wall = midnight(wallTimeAt(span.start, zone))
  while (true) {
    const dayStart = instantOf(wall, zone)
    if (dayStart >= span.end) break
    const next = addCalendarDays(wall, 1)
    const dayEnd = instantOf(next, zone)
    days.push({ date: isoDate(wall), start: Math.max(dayStart, span.start), end: Math.min(dayEnd, span.end) })
    wall = next
  }
  return days
}
