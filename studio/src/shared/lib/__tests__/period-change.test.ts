import { periodChange, wholePercent } from '../period-change'

const ratio = (numerator: number, denominator: number) => ({ numerator, denominator })

describe('periodChange', () => {
  it('shows a count against its previous period as a whole percent, green when up is good', () => {
    expect(periodChange({ kind: 'count', current: 120, previous: 100 }, 'up')).toEqual({
      label: '+20%',
      direction: 'up',
      tone: 'good',
    })
  })

  it('shows a falling count in red', () => {
    expect(periodChange({ kind: 'count', current: 80, previous: 100 }, 'up')).toEqual({
      label: '-20%',
      direction: 'down',
      tone: 'bad',
    })
  })

  it('reads "No change" for 0 against 0 and "New" for 5 against 0', () => {
    expect(periodChange({ kind: 'count', current: 0, previous: 0 }, 'up')).toEqual({
      label: 'No change',
      direction: 'flat',
      tone: 'neutral',
    })
    expect(periodChange({ kind: 'count', current: 5, previous: 0 }, 'up')).toEqual({
      label: 'New',
      direction: 'up',
      tone: 'good',
    })
  })

  it('shows a change that rounds to 0% in gray', () => {
    expect(periodChange({ kind: 'count', current: 1001, previous: 1000 }, 'up')).toEqual({
      label: '0%',
      direction: 'flat',
      tone: 'neutral',
    })
  })

  it('rounds halves away from zero in both directions', () => {
    expect(periodChange({ kind: 'count', current: 205, previous: 200 }, 'up')?.label).toBe('+3%')
    expect(periodChange({ kind: 'count', current: 195, previous: 200 }, 'up')?.label).toBe('-3%')
  })

  it('shows lag of 90 s against 60 s as +50% in red, since up is bad for lag', () => {
    expect(periodChange({ kind: 'duration', current: 90_000, previous: 60_000 }, 'down')).toEqual({
      label: '+50%',
      direction: 'up',
      tone: 'bad',
    })
  })

  it('shows no change for a duration whose previous period had no activity or was 0 s', () => {
    expect(periodChange({ kind: 'duration', current: 2_000, previous: null }, 'down')).toBeNull()
    expect(periodChange({ kind: 'duration', current: 2_000, previous: 0 }, 'down')).toBeNull()
    expect(periodChange({ kind: 'duration', current: null, previous: 2_000 }, 'down')).toBeNull()
  })

  it('shows a rate change in points from the two whole percents on screen', () => {
    // Unrounded, 41% against 43.6% is 2.6 points. On screen, 41% against 44% is 3.
    const change = periodChange({ kind: 'rate', current: ratio(41, 100), previous: ratio(436, 1000) }, 'up')
    expect(wholePercent(ratio(436, 1000))).toBe(44)
    expect(change).toEqual({ label: '-3 pts', direction: 'down', tone: 'bad' })
  })

  it('shows an unchanged rate as 0 pts in gray', () => {
    expect(periodChange({ kind: 'rate', current: ratio(1, 2), previous: ratio(5, 10) }, 'up')).toEqual({
      label: '0 pts',
      direction: 'flat',
      tone: 'neutral',
    })
  })

  it('shows no change for a rate when either period had nothing to divide', () => {
    expect(periodChange({ kind: 'rate', current: ratio(41, 100), previous: ratio(0, 0) }, 'up')).toBeNull()
    expect(periodChange({ kind: 'rate', current: ratio(0, 0), previous: ratio(41, 100) }, 'up')).toBeNull()
  })
})
