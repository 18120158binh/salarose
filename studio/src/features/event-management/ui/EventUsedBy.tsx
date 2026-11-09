import Link from "next/link";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import type { EventCampaignUseKind, EventUseSummary } from "./EventDetailControls";

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="font-semibold text-muted-foreground text-xs tracking-wide">{children}</h3>;
}

// The journey list's tones: Live is success, Paused is warning, anything else reads as a draft.
function status(value: string) {
  if (value === "active") return <StatusBadge tone="success">Live</StatusBadge>;
  if (value === "paused") return <StatusBadge tone="warning">Paused</StatusBadge>;
  return <StatusBadge tone="neutral">Draft</StatusBadge>;
}

const USE_LINE: Record<EventCampaignUseKind, string> = {
  trigger: "A step waits for this event",
  metric: "A step checks a metric on this event",
};

function SecondLine({ children }: { children: React.ReactNode }) {
  return <span className="block text-muted-foreground text-xs">{children}</span>;
}

/**
 * CAT-FR-20: the journeys, metric definitions, and segments that use the event. The metrics link to
 * Data > Metrics once that page is open to the viewer; until then the link is left out.
 */
export function EventUsedBy({ uses, metricsHref }: { uses: EventUseSummary; metricsHref: string | null }) {
  return (
    <SectionCard description="Changing or deleting this event affects everything listed here." title="Where it's used">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-1.5">
          <Heading>
            JOURNEYS · <span className="font-heading tabular-nums">{uses.campaigns.length}</span>
          </Heading>
          {uses.campaigns.length === 0 ? (
            <p className="text-muted-foreground text-xs">No published journey uses this event.</p>
          ) : (
            <ul className="divide-y divide-border rounded-tile border border-border">
              {uses.campaigns.map((campaign) => (
                <li className="flex flex-wrap items-center gap-3 px-3.5 py-2.5" key={campaign.id}>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{campaign.name}</span>
                    <SecondLine>{campaign.kinds.map((kind) => USE_LINE[kind]).join(" · ")}</SecondLine>
                  </span>
                  {status(campaign.status)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <Heading>
                <span className="font-heading tabular-nums">{uses.metrics.length}</span> {uses.metrics.length === 1 ? "METRIC USES" : "METRICS USE"} THIS EVENT
              </Heading>
              {metricsHref !== null && (
                <Link className="ml-auto font-semibold text-primary text-xs hover:underline" href={metricsHref}>
                  See all metrics
                </Link>
              )}
            </div>
            {uses.metrics.length === 0 ? (
              <p className="text-muted-foreground text-xs">No metric counts this event.</p>
            ) : (
              <ul className="divide-y divide-border rounded-tile border border-border">
                {uses.metrics.map((metric) => (
                  <li className="px-3.5 py-2" key={metric.id}>
                    <span className="font-semibold">{metric.displayName}</span>
                    <SecondLine>{metric.measure}</SecondLine>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Heading>
              SEGMENTS · <span className="font-heading tabular-nums">{uses.segments.length}</span>
            </Heading>
            {uses.segments.length === 0 ? (
              <p className="text-muted-foreground text-xs">No segment uses this event.</p>
            ) : (
              <ul className="divide-y divide-border rounded-tile border border-border">
                {uses.segments.map((segment) => (
                  <li className="px-3.5 py-2" key={segment.id}>
                    <span className="font-semibold">{segment.name}</span>
                    {segment.description && <SecondLine>{segment.description}</SecondLine>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
