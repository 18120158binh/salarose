import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon, CircleCheckIcon, CircleMinusIcon, CircleXIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCount, formatDuration, formatTimestamp, NOT_AVAILABLE } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import type { Reach } from "@/widgets/v2-shell/model/routes";
import { droppedLink, droppedTone, lagTone, type HealthTone, type PipelineHealth } from "../model/home";

// The icon and the words carry the state, so it never rests on color alone.
const TONES: Record<HealthTone, { icon: LucideIcon; className: string; word: string }> = {
  good: { icon: CircleCheckIcon, className: "text-success", word: "Good" },
  warning: { icon: TriangleAlertIcon, className: "text-warning", word: "Warning" },
  bad: { icon: CircleXIcon, className: "text-destructive", word: "Bad" },
  quiet: { icon: CircleMinusIcon, className: "text-muted-foreground", word: "No data" },
};

export interface HealthStripProps {
  health: Promise<PipelineHealth>;
  viewer: Reach;
  now: number;
  zone: TimeZone;
  // A caption at the strip's end, for a page that reuses the strip.
  note?: string;
}

// HOM-FR-08: lag, dropped records, and the last journey step in the last hour.
export async function HealthStrip({ health, viewer, now, zone, note }: HealthStripProps) {
  const { lag, dropped, lastTransitionAt } = await health;
  const link = droppedLink(viewer);
  const last = lastTransitionAt === null ? null : formatTimestamp(lastTransitionAt, now, zone);

  return (
    <section
      aria-label="Pipeline health"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground text-sm lg:flex-row lg:items-center lg:gap-0"
    >
      <h2 className="font-medium text-muted-foreground text-xs lg:pr-4">Pipeline, last hour</h2>
      <Item tone={lagTone(lag)}>
        {lag === null ? "No journey activity in the last hour" : <>Lag {formatDuration(lag)} at p95</>}
      </Item>
      {dropped.available ? (
        <Item tone={droppedTone(dropped.value)}>
          <span>
            {formatCount(dropped.value)} dropped {dropped.value === 1 ? "record" : "records"}
          </span>
          {link && (
            <Link
              className="inline-flex items-center gap-0.5 rounded-sm font-medium text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              href={link.href}
            >
              {link.text}
              <ArrowRightIcon aria-hidden className="size-3" />
            </Link>
          )}
        </Item>
      ) : (
        <Item tone="quiet">
          <span>Dropped records: {NOT_AVAILABLE}.</span>
          <span className="text-muted-foreground text-xs">{dropped.reason}</span>
        </Item>
      )}
      <Item>
        {last === null ? (
          "No journey step yet"
        ) : (
          <span>
            Last journey step <time title={last.exact}>{last.text}</time>
          </span>
        )}
      </Item>
      {note && <span className="text-muted-foreground text-xs lg:ml-auto lg:pl-4">{note}</span>}
    </section>
  );
}

function Item({ tone, children }: { tone?: HealthTone; children: ReactNode }) {
  const state = tone ? TONES[tone] : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 lg:border-border lg:border-l lg:px-4">
      {state && (
        <>
          <state.icon aria-hidden className={cn("size-4 shrink-0", state.className)} />
          <span className="sr-only">{state.word}:</span>
        </>
      )}
      {children}
    </p>
  );
}
