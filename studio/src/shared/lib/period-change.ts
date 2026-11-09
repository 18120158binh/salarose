/** Which way of moving is good for a number: up for counts, down for lag. */
export type GoodWhen = 'up' | 'down'

export type Tone = 'good' | 'bad' | 'neutral'

/** A rate as its parts, so a period with nothing to divide is a value, not NaN. */
export type Ratio = { readonly numerator: number; readonly denominator: number }

/**
 * A number and its previous period. `null` means the period had no activity to measure:
 * no finished watch for a rate, no transition for a duration.
 */
export type Comparison =
  | { readonly kind: 'count'; readonly current: number; readonly previous: number }
  | { readonly kind: 'duration'; readonly current: number | null; readonly previous: number | null }
  | { readonly kind: 'rate'; readonly current: Ratio; readonly previous: Ratio }

export type Change = {
  readonly label: string
  readonly direction: 'up' | 'down' | 'flat'
  readonly tone: Tone
}

/** Rounds half away from zero, so +2.5% and -2.5% round to the same size. */
function roundWhole(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

/** The whole percent a rate shows on screen, or `null` when it has nothing to divide. */
export function wholePercent(ratio: Ratio): number | null {
  return ratio.denominator > 0 ? roundWhole((100 * ratio.numerator) / ratio.denominator) : null
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function directed(delta: number, label: string, goodWhen: GoodWhen): Change {
  if (delta === 0) return { label, direction: 'flat', tone: 'neutral' }
  const direction = delta > 0 ? 'up' : 'down'
  return { label, direction, tone: direction === goodWhen ? 'good' : 'bad' }
}

function percentChange(current: number, previous: number, goodWhen: GoodWhen): Change {
  const percent = roundWhole((100 * (current - previous)) / previous)
  return directed(percent, `${signed(percent)}%`, goodWhen)
}

/**
 * The change against the previous period, by the studio shell rule. `null` means no change is
 * shown.
 */
export function periodChange(comparison: Comparison, goodWhen: GoodWhen): Change | null {
  switch (comparison.kind) {
    case 'count': {
      const { current, previous } = comparison
      if (previous === 0) {
        return current === 0
          ? { label: 'No change', direction: 'flat', tone: 'neutral' }
          : directed(1, 'New', goodWhen)
      }
      return percentChange(current, previous, goodWhen)
    }
    case 'duration': {
      const { current, previous } = comparison
      if (current === null || previous === null || previous === 0) return null
      return percentChange(current, previous, goodWhen)
    }
    case 'rate': {
      const current = wholePercent(comparison.current)
      const previous = wholePercent(comparison.previous)
      if (current === null || previous === null) return null
      const points = current - previous
      return directed(points, `${signed(points)} pts`, goodWhen)
    }
  }
}
