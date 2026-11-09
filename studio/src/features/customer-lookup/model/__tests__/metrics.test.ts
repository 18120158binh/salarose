import { metricLabel, metricValue, parseBuckets, parseMetricFunction, retentionLabel, type Bucket } from '../metrics'

function bucket(start: number, fields: Partial<Bucket> = {}): Bucket {
  return { start, count: 1, sum: null, valueCount: null, min: null, max: null, newest: [], ...fields }
}

describe('metricValue at the series clock, with no window', () => {
  it('leaves out a bucket that starts after the clock', () => {
    expect(metricValue('COUNT', [bucket(0, { count: 2 }), bucket(500, { count: 9 })], 100)).toEqual({ kind: 'value', value: 2 })
  })

  it('sums the sums, and gives 0 with no numeric value', () => {
    expect(metricValue('SUM', [bucket(0, { sum: 10, valueCount: 1 }), bucket(1, { sum: 5.5, valueCount: 2 })], 1)).toEqual({ kind: 'value', value: 15.5 })
    expect(metricValue('SUM', [bucket(0)], 1)).toEqual({ kind: 'value', value: 0 })
  })

  it('averages over the numeric values, and has no value with none', () => {
    expect(metricValue('AVG', [bucket(0, { sum: 10, valueCount: 1 }), bucket(1, { sum: 20, valueCount: 3 })], 1)).toEqual({ kind: 'value', value: 7.5 })
    expect(metricValue('AVG', [bucket(0)], 1)).toEqual({ kind: 'no-value' })
  })

  it('takes the smallest minimum and the largest maximum', () => {
    const buckets = [bucket(0, { min: 3, max: 8 }), bucket(1, { min: 1, max: 4 }), bucket(2)]
    expect(metricValue('MIN', buckets, 2)).toEqual({ kind: 'value', value: 1 })
    expect(metricValue('MAX', buckets, 2)).toEqual({ kind: 'value', value: 8 })
    expect(metricValue('MAX', [bucket(0)], 2)).toEqual({ kind: 'no-value' })
  })

  it('reads LATEST and DIFF from the newest two across buckets, the later event id winning a tie', () => {
    const buckets = [
      bucket(0, { newest: [{ eventId: 'a', eventTime: 10, value: 100 }] }),
      bucket(1, { newest: [{ eventId: 'b', eventTime: 20, value: 90 }, { eventId: 'c', eventTime: 20, value: 80 }] }),
    ]
    expect(metricValue('LATEST', buckets, 1)).toEqual({ kind: 'value', value: 80 })
    expect(metricValue('DIFF', buckets, 1)).toEqual({ kind: 'value', value: 10 })
    expect(metricValue('PRICE_DROP', [bucket(0, { newest: [{ eventId: 'a', eventTime: 1, value: 5 }] })], 1)).toEqual({ kind: 'no-value' })
  })

  it('does not show MEDIAN or DISTINCT_COUNT, and gives their occurrence count', () => {
    expect(metricValue('DISTINCT_COUNT', [bucket(0, { count: 3 }), bucket(1, { count: 4 })], 1)).toEqual({ kind: 'not-shown', occurrences: 7 })
  })
})

describe('parseBuckets', () => {
  it('reads the stored shape, and treats a missing or wrong optional field as absent', () => {
    expect(parseBuckets([{ size: 'HOUR', start: 0, count: 2, sum: 'x', min: 1 }])).toEqual([bucket(0, { count: 2, min: 1 })])
  })

  it.each([[{}], ['[]'], [[{ size: 'HOUR', count: 1 }]], [[{ size: 'YEAR', start: 0, count: 1 }]], [[null]]])('rejects %j', (value) => {
    expect(parseBuckets(value)).toBeNull()
  })
})

describe('labels', () => {
  it('gives the display name, the function line, and the system name with the function (CUS-FR-08)', () => {
    expect(metricLabel('add_to_cart', 'Added to cart', 'COUNT', null, 30 * 86_400_000)).toEqual({
      event: 'Added to cart',
      measure: 'number of times, last 30 days',
      system: 'add_to_cart · COUNT',
    })
    expect(metricLabel('order_completed', null, 'SUM', 'order.total', 30 * 86_400_000)).toEqual({
      event: 'order_completed',
      measure: 'total of order.total, last 30 days',
      system: 'order_completed · SUM',
    })
    expect(metricLabel('search', '  ', 'DISTINCT_COUNT', 'query', 86_400_000).measure).toBe('number of different query, last 1 day')
    expect(retentionLabel(36 * 3_600_000)).toBe('36 hours')
    expect(retentionLabel(86_400_000)).toBe('1 day')
  })

  it('reads a missing or unknown function as COUNT', () => {
    expect(parseMetricFunction(null)).toBe('COUNT')
    expect(parseMetricFunction('nope')).toBe('COUNT')
    expect(parseMetricFunction('avg')).toBe('AVG')
  })
})
