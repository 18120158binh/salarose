"use client";

import { scaleBand, scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import type React from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** One point of a chart: what it is called on screen, such as "Nov 7" or "Yes", and its value. */
export type ChartPoint = { readonly label: string; readonly value: number };

type ChartProps = {
  points: readonly ChartPoint[];
  /** Names the chart for assistive tech and captions its table. */
  label: string;
  /** The table's header for the point labels, such as "Day" or "Branch". */
  categoryLabel: string;
  /** The table's header for the values, such as "Entries". */
  valueLabel: string;
  format?: (value: number) => string;
  className?: string;
};

const defaultFormat = (value: number) => value.toLocaleString();

function useActivePoint(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (count === 0) return;
    const next: Record<string, number> = {
      ArrowRight: Math.min((active ?? -1) + 1, count - 1),
      ArrowLeft: Math.max((active ?? count) - 1, 0),
      Home: 0,
      End: count - 1,
    };
    if (event.key === "Escape") setActive(null);
    else if (event.key in next) {
      event.preventDefault();
      setActive(next[event.key] ?? null);
    }
  };
  return { active, setActive, onKeyDown, onBlur: () => setActive(null) };
}

function ChartTooltip({ point, left, format }: { point: ChartPoint; left: number; format: (value: number) => string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-xs"
      style={{ left: `${Math.min(Math.max(left, 10), 90)}%` }}
    >
      <span className="text-muted-foreground">{point.label}</span>{" "}
      <span className="font-medium tabular-nums">{format(point.value)}</span>
    </div>
  );
}

function ChartTable({ points, label, categoryLabel, valueLabel, format }: Required<Omit<ChartProps, "className">>) {
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">{categoryLabel}</th>
          <th scope="col">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point, index) => (
          <tr key={index}>
            <th scope="row">{point.label}</th>
            <td>{format(point.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const focusRing = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// Charts draw in percents of their box, so the SVG fills its container on the server and in the
// browser alike, with nothing to measure first.

/** DESIGN.md KPI card sparkline: 32px tall, full width, one 2px `chart-1` line, no axes or dots. */
export function Sparkline({ points, label, categoryLabel, valueLabel, format = defaultFormat, className }: ChartProps) {
  const { active, setActive, onKeyDown, onBlur } = useActivePoint(points.length);
  const values = points.map((point) => point.value);
  const x = scaleLinear({ domain: [0, Math.max(points.length - 1, 1)], range: [0, 100] });
  const y = scaleLinear({ domain: [Math.min(...values, 0), Math.max(...values, 0)], range: [30, 2] });
  const activePoint = active === null ? undefined : points[active];

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || points.length === 0) return;
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    setActive(Math.round(ratio * (points.length - 1)));
  };

  return (
    <div
      aria-label={label}
      className={cn("relative h-8 w-full", focusRing, className)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onPointerLeave={onBlur}
      onPointerMove={onPointerMove}
      role="group"
      tabIndex={0}
    >
      <svg aria-hidden className="block size-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 32">
        {points.length > 1 && (
          <LinePath
            className="fill-none stroke-chart-1"
            data={values}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            x={(_, index) => x(index)}
            y={(value) => y(value)}
          />
        )}
      </svg>
      {activePoint && active !== null && <ChartTooltip format={format} left={x(active)} point={activePoint} />}
      <ChartTable categoryLabel={categoryLabel} format={format} label={label} points={points} valueLabel={valueLabel} />
    </div>
  );
}

/**
 * DESIGN.md Charts: vertical bars in `chart-1` with 2px top corners, horizontal 1px gridlines,
 * caption axis labels in the muted color. The caller groups anything past five bars as "Other".
 */
export function BarChart({
  points,
  label,
  categoryLabel,
  valueLabel,
  format = defaultFormat,
  className,
}: ChartProps) {
  const { active, setActive, onKeyDown, onBlur } = useActivePoint(points.length);
  const x = scaleBand({ domain: points.map((_, index) => index), range: [0, 100], padding: 0.3 });
  const y = scaleLinear({ domain: [0, Math.max(...points.map((point) => point.value), 1)], range: [100, 0], nice: true });
  const ticks = y.ticks(4);
  const center = (index: number) => (x(index) ?? 0) + x.bandwidth() / 2;
  const activePoint = active === null ? undefined : points[active];

  return (
    <div className={cn("grid h-40 w-full grid-cols-[2.5rem_1fr] grid-rows-[1fr_1.5rem] gap-x-2", className)}>
      <div aria-hidden className="relative text-muted-foreground text-xs tabular-nums">
        {ticks.map((tick) => (
          <span className="absolute right-0 -translate-y-1/2" key={tick} style={{ top: `${y(tick)}%` }}>
            {format(tick)}
          </span>
        ))}
      </div>
      <div
        aria-label={label}
        className={cn("relative min-h-0", focusRing)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onPointerLeave={onBlur}
        role="group"
        tabIndex={0}
      >
        <svg aria-hidden className="block size-full">
          {ticks.map((tick) => (
            <line className="stroke-border" key={tick} strokeWidth={1} x1="0" x2="100%" y1={`${y(tick)}%`} y2={`${y(tick)}%`} />
          ))}
          {points.map((point, index) => (
            // The bar runs past the plot's bottom edge, which clips its lower rounded corners.
            <rect
              className={cn("fill-chart-1", active !== null && active !== index && "opacity-60")}
              key={index}
              onPointerEnter={() => setActive(index)}
              rx={2}
              width={`${x.bandwidth()}%`}
              x={`${x(index) ?? 0}%`}
              y={`${y(point.value)}%`}
              height="100%"
            />
          ))}
        </svg>
        {activePoint && active !== null && <ChartTooltip format={format} left={center(active)} point={activePoint} />}
        <ChartTable categoryLabel={categoryLabel} format={format} label={label} points={points} valueLabel={valueLabel} />
      </div>
      <div aria-hidden className="relative col-start-2 text-muted-foreground text-xs">
        {points.map((point, index) => (
          <span
            className="absolute top-1.5 max-w-24 -translate-x-1/2 truncate"
            key={index}
            style={{ left: `${center(index)}%` }}
          >
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
}
