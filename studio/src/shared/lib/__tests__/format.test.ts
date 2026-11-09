import { formatCount, formatDateTime, formatDuration, formatRate, formatSignedCount, formatTimestamp } from '../format'
import { parseTimeZone } from '../time-range'

const HCM = parseTimeZone('Asia/Ho_Chi_Minh')
const NEW_YORK = parseTimeZone('America/New_York')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('counts and rates', () => {
  it('groups thousands by the locale', () => {
    expect(formatCount(12480)).toBe('12,480')
    expect(formatCount(12480, 'de-DE')).toBe('12.480')
    expect(formatCount(0)).toBe('0')
  })

  it('signs a difference in counts', () => {
    expect(formatSignedCount(1204)).toBe('+1,204')
    expect(formatSignedCount(-890)).toBe('-890')
    expect(formatSignedCount(0)).toBe('0')
  })

  it('shows a rate as a whole percent, and nothing when it has nothing to divide', () => {
    expect(formatRate({ numerator: 2, denominator: 3 })).toBe('67%')
    expect(formatRate({ numerator: 0, denominator: 0 })).toBeNull()
  })
})

describe('formatDuration', () => {
  it('uses the largest two units that apply', () => {
    expect(formatDuration(4 * MINUTE + 12_000)).toBe('4 min 12 s')
    expect(formatDuration(2 * HOUR + 5 * MINUTE + 30_000)).toBe('2 h 5 min')
    expect(formatDuration(26 * HOUR + 3 * MINUTE)).toBe('1 d 2 h')
    expect(formatDuration(42_700)).toBe('42 s')
  })

  it('leaves out a second unit that is zero', () => {
    expect(formatDuration(2 * HOUR + 40_000)).toBe('2 h')
  })

  it('reads under a second as "< 1 s", and nothing as "0 s"', () => {
    expect(formatDuration(400)).toBe('< 1 s')
    expect(formatDuration(0)).toBe('0 s')
  })
})

describe('formatTimestamp', () => {
  const now = Date.parse('2026-11-10T09:30:00+07:00')

  it('reads a time within the last 24 hours relative to now, with the exact time for the hover', () => {
    expect(formatTimestamp(now - 12 * MINUTE, now, HCM)).toEqual({ text: '12 min ago', exact: 'Nov 10, 2026, 9:18 AM' })
    expect(formatTimestamp(now - 2 * HOUR - 5 * MINUTE, now, HCM).text).toBe('2 h ago')
    expect(formatTimestamp(now - 20_000, now, HCM).text).toBe('just now')
  })

  it('reads an older time as its date and time in the viewer zone', () => {
    const instant = now - 24 * HOUR
    expect(formatTimestamp(instant, now, HCM).text).toBe('Nov 9, 2026, 9:30 AM')
    expect(formatTimestamp(instant, now, NEW_YORK).text).toBe('Nov 8, 2026, 9:30 PM')
  })

  it('formats in the zone it is given, not the zone the process runs in', () => {
    expect(formatDateTime(Date.parse('2026-11-10T00:30:00Z'), parseTimeZone('UTC'))).toBe('Nov 10, 2026, 12:30 AM')
  })
})
