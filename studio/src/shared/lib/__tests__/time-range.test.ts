import {
  computeRange,
  parseRange,
  parseTimeZone,
  rangeLabel,
  splitIntoDays,
  UTC,
  zoneCacheSizes,
  zoneLabel,
  type TimeZone,
} from '../time-range'

const at = (iso: string) => Date.parse(iso)
const HCM = parseTimeZone('Asia/Ho_Chi_Minh')
const NEW_YORK = parseTimeZone('America/New_York')
const HOUR = 3_600_000

describe('computeRange', () => {
  const now = at('2026-11-10T09:30:00+07:00')

  it('Today runs from local midnight to now, and its previous period covers the same hours of yesterday', () => {
    const range = computeRange('today', now, HCM)
    expect(range.current).toEqual({ start: at('2026-11-10T00:00:00+07:00'), end: now })
    expect(range.previous).toEqual({ start: at('2026-11-09T00:00:00+07:00'), end: at('2026-11-09T09:30:00+07:00') })
  })

  it('Last 7 days starts at midnight 6 calendar days back, and its previous period is 7 days earlier', () => {
    const range = computeRange('7d', now, HCM)
    expect(range.current).toEqual({ start: at('2026-11-04T00:00:00+07:00'), end: now })
    expect(range.previous).toEqual({ start: at('2026-10-28T00:00:00+07:00'), end: at('2026-11-03T09:30:00+07:00') })
  })

  it('Last 30 days starts at midnight 29 calendar days back, and its previous period is 30 days earlier', () => {
    const range = computeRange('30d', now, HCM)
    expect(range.current).toEqual({ start: at('2026-10-12T00:00:00+07:00'), end: now })
    expect(range.previous).toEqual({ start: at('2026-09-12T00:00:00+07:00'), end: at('2026-10-11T09:30:00+07:00') })
  })

  it('uses the zone it is given, not the zone the process runs in', () => {
    const range = computeRange('today', now, UTC)
    expect(range.current.start).toEqual(at('2026-11-10T00:00:00Z'))
  })

  it('keeps wall-clock times across the end of daylight saving, so yesterday was 25 hours', () => {
    const range = computeRange('today', at('2026-11-02T09:30:00-05:00'), NEW_YORK)
    expect(range.current.start).toEqual(at('2026-11-02T00:00:00-05:00'))
    expect(range.previous).toEqual({ start: at('2026-11-01T00:00:00-04:00'), end: at('2026-11-01T09:30:00-05:00') })
    expect(range.previous.end - range.previous.start).toBe(10.5 * HOUR)
  })

  it('maps a wall time that occurs twice to the earlier instant', () => {
    const range = computeRange('today', at('2026-11-02T01:30:00-05:00'), NEW_YORK)
    expect(range.previous.end).toEqual(at('2026-11-01T01:30:00-04:00'))
  })

  it('moves a wall time skipped by the start of daylight saving forward by the jump', () => {
    const range = computeRange('today', at('2026-03-09T02:30:00-04:00'), NEW_YORK)
    expect(range.previous.end).toEqual(at('2026-03-08T03:30:00-04:00'))
  })
})

describe('splitIntoDays', () => {
  it('splits a range into calendar days of the zone, the last one ending at now', () => {
    const range = computeRange('7d', at('2026-11-10T09:30:00+07:00'), HCM)
    const days = splitIntoDays(range.current, HCM)
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ])
    expect(days[0]).toEqual({ date: '2026-11-04', start: at('2026-11-04T00:00:00+07:00'), end: at('2026-11-05T00:00:00+07:00') })
    expect(days[6].end).toEqual(range.current.end)
  })

  it('gives America/New_York a 25-hour 2026-11-01 and a 23-hour 2026-03-08', () => {
    const lengthOf = (date: string, zone: TimeZone) => {
      const start = at(`${date}T00:00:00Z`) - 2 * 24 * HOUR
      const days = splitIntoDays({ start, end: start + 5 * 24 * HOUR }, zone)
      const day = days.find((d) => d.date === date)!
      return day.end - day.start
    }
    expect(lengthOf('2026-11-01', NEW_YORK)).toBe(25 * HOUR)
    expect(lengthOf('2026-03-08', NEW_YORK)).toBe(23 * HOUR)
    expect(lengthOf('2026-11-01', HCM)).toBe(24 * HOUR)
  })

  it('leaves no gap and no overlap between days', () => {
    const range = computeRange('30d', at('2026-11-15T12:00:00-05:00'), NEW_YORK)
    const days = splitIntoDays(range.current, NEW_YORK)
    expect(days).toHaveLength(30)
    expect(days[0].start).toBe(range.current.start)
    for (let i = 1; i < days.length; i++) expect(days[i].start).toBe(days[i - 1].end)
  })

  it('returns one partial day for Today', () => {
    const range = computeRange('today', at('2026-11-10T09:30:00+07:00'), HCM)
    expect(splitIntoDays(range.current, HCM)).toEqual([{ date: '2026-11-10', ...range.current }])
  })
})

describe('parseRange', () => {
  it('reads the three ranges', () => {
    expect(parseRange('today')).toEqual({ key: 'today', rewrite: false })
    expect(parseRange('7d')).toEqual({ key: '7d', rewrite: false })
    expect(parseRange('30d')).toEqual({ key: '30d', rewrite: false })
  })

  it('defaults to Last 7 days when the address has no range', () => {
    expect(parseRange(undefined)).toEqual({ key: '7d', rewrite: false })
  })

  it('uses Last 7 days and asks for the address to be rewritten when the range is unknown', () => {
    expect(parseRange('90d')).toEqual({ key: '7d', rewrite: true })
    expect(parseRange('')).toEqual({ key: '7d', rewrite: true })
  })

  it('reads the first value of a repeated parameter', () => {
    expect(parseRange(['30d', 'today'])).toEqual({ key: '30d', rewrite: false })
  })
})

describe('parseTimeZone', () => {
  it('accepts an IANA zone from the tz cookie', () => {
    expect(parseTimeZone('Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh')
  })

  it('falls back to UTC when the cookie is missing or holds no zone', () => {
    expect(parseTimeZone(undefined)).toBe('UTC')
    expect(parseTimeZone('')).toBe('UTC')
    expect(parseTimeZone('Mars/Olympus_Mons')).toBe('UTC')
    expect(parseTimeZone('<script>')).toBe('UTC')
  })

  it('rejects values that are not shaped like an IANA name, such as offsets', () => {
    expect(parseTimeZone('+07:00')).toBe('UTC')
    expect(parseTimeZone('Asia/Ho_Chi_Minh/../x')).toBe('UTC')
    expect(parseTimeZone(`Asia/${'A'.repeat(80)}`)).toBe('UTC')
  })

  it('computes the same range for every spelling of a zone', () => {
    const now = at('2026-11-10T09:30:00+07:00')
    expect(computeRange('today', now, parseTimeZone('asia/ho_chi_minh'))).toMatchObject({
      current: computeRange('today', now, HCM).current,
    })
  })

  it('keeps one formatter per zone and a bounded spelling cache, whatever the cookie holds', () => {
    const spellings: string[] = []
    for (let mask = 0; mask < 2048; mask++) {
      spellings.push(
        [...'Asia/Ho_Chi_Minh'].map((c, i) => (mask >> (i % 11)) & 1 ? c.toUpperCase() : c.toLowerCase()).join(''),
      )
    }
    const before = zoneCacheSizes().formatters
    for (const spelling of spellings) parseTimeZone(spelling)

    expect(zoneCacheSizes().formatters - before).toBeLessThanOrEqual(1)
    expect(zoneCacheSizes().spellings).toBeLessThanOrEqual(512)
  })
})

describe('labels', () => {
  it('names the ranges and the zone for the range picker', () => {
    expect(rangeLabel('today')).toBe('Today')
    expect(rangeLabel('7d')).toBe('Last 7 days')
    expect(rangeLabel('30d')).toBe('Last 30 days')
    expect(zoneLabel(HCM)).toBe('Times in Asia/Ho_Chi_Minh')
    expect(zoneLabel(UTC)).toBe('Times in UTC')
  })
})
