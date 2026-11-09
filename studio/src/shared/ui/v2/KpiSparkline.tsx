"use client";

import { Sparkline, type ChartPoint } from "@/components/ui/chart";
import { formatCount, formatDuration } from "@/shared/lib/format";

// How a trend's values read in the tooltip and the table. A name, not a function, so a server
// component can pass it to this client component.
export type TrendUnit = "count" | "percent" | "duration";

const FORMAT: Record<TrendUnit, (value: number) => string> = {
  count: (value) => formatCount(value),
  percent: (value) => `${value}%`,
  duration: formatDuration,
};

export interface KpiSparklineProps {
  label: string;
  points: readonly ChartPoint[];
  unit: TrendUnit;
  className?: string;
}

// A line needs two points. With fewer, the card's value already says everything.
export function KpiSparkline({ label, points, unit, className }: KpiSparklineProps) {
  if (points.length < 2) return null;
  return (
    <Sparkline
      categoryLabel="Period"
      className={className}
      format={FORMAT[unit]}
      label={`${label} per period`}
      points={points}
      valueLabel={label}
    />
  );
}
