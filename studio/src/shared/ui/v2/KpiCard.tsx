import type { ReactNode } from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon, InfoIcon } from "lucide-react";
import type { ChartPoint } from "@/components/ui/chart";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Reading } from "@/shared/lib/format";
import type { Change, Tone } from "@/shared/lib/period-change";
import { KpiSparkline, type TrendUnit } from "./KpiSparkline";
import { NotAvailable, RegionSkeleton } from "./states";

export interface KpiCardProps {
  label: string;
  // The number's definition in one sentence, behind the info icon.
  definition: string;
  // The formatted value, or why the page could not compute it (SHL-FR-17).
  value: Reading<string>;
  // From periodChange. `null` shows no change, as the shell rule asks for some periods.
  change: Change | null;
  // A second line under the value, such as the counts behind a rate: "2 of 3".
  detail?: string;
  // The value per period, oldest first, for the sparkline. `unit` says how one point's exact value
  // reads. It is a name rather than a format function, because this card renders on the server
  // and the sparkline in the browser, and a function cannot cross that boundary.
  trend?: { points: readonly ChartPoint[]; unit: TrendUnit };
}

const TONE: Record<Tone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
};

export function KpiCard({ label, definition, value, change, detail, trend }: KpiCardProps) {
  return (
    <section aria-label={label} className="flex flex-col gap-2 rounded-tile border border-border bg-card p-4 text-card-foreground">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            aria-label={`What ${label} means`}
            className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <InfoIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{definition}</TooltipPopup>
        </Tooltip>
      </div>
      {value.available ? (
        <p className="font-heading font-semibold text-[1.625rem] leading-tight tabular-nums">{value.value}</p>
      ) : (
        <div className="text-sm">
          <NotAvailable reason={value.reason} />
        </div>
      )}
      {value.available && detail && <p className="text-muted-foreground text-xs tabular-nums">{detail}</p>}
      {value.available && change && <ChangeLine change={change} />}
      {value.available && trend && (
<KpiSparkline label={label} points={trend.points} unit={trend.unit} />
      )}
    </section>
  );
}

// The arrow and the sign carry the direction as well as the color, never color alone.
function ChangeLine({ change }: { change: Change }) {
  const Arrow = change.direction === "up" ? ArrowUpRightIcon : change.direction === "down" ? ArrowDownRightIcon : null;
  return (
    <p className={cn("flex items-center gap-1 text-xs tabular-nums", TONE[change.tone])}>
      {Arrow && <Arrow aria-hidden className="size-3.5" />}
      <span>{change.label}</span>
      <span className="text-muted-foreground">vs previous period</span>
    </p>
  );
}

export function KpiCardSkeleton() {
  return <RegionSkeleton className="h-[9.5rem]" />;
}

// DESIGN.md: four cards at 1024px and up, two at 768px, one below.
export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">{children}</div>;
}
