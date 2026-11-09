import Link from "next/link";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import type { TrackingPlan } from "../model/plan";
import { DROPS } from "../model/samples";

const LINK = "font-medium text-primary text-sm hover:underline";

/** DHL-FR-15: the catalog's active events as the tracking plan, in the order Events lists them. */
export async function TrackingPlanCard({ plan, admin }: { plan: Promise<TrackingPlan>; admin: boolean }) {
  const { size, events } = await plan;
  return (
    <SectionCard
      actions={<span className="font-heading text-muted-foreground text-xs tabular-nums">{size === 1 ? "1 event" : `${size} events`}</span>}
      description="The names your code must send. Changes happen in Events."
      title="Your tracking plan"
    >
      {events.length === 0 ? (
        <p className="text-muted-foreground text-sm">Events has no active event yet. Add one before you ship the code that sends it.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {events.map((event) => (
            <li className="flex flex-col gap-0.5 py-2" key={event.name}>
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{event.label}</span>
                <span className="text-muted-foreground text-xs">{event.note}</span>
              </span>
              <span className="font-mono text-muted-foreground text-xs">{event.name}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <Link className={LINK} href="/v2/data/events">
          {size > 0 ? `See all ${size} in Events` : "Open Events"}
        </Link>
        {admin && (
          <Link className={LINK} href="/v2/data/events">
            Add an event before you ship it
          </Link>
        )}
      </div>
    </SectionCard>
  );
}

export function DropsCard() {
  return (
    <SectionCard description="Studio drops these quietly. Check them before every release." title="What gets dropped">
      <dl className="flex flex-col divide-y divide-border text-sm">
        {DROPS.map((drop) => (
          <div className="flex justify-between gap-3 py-1.5" key={drop.what}>
            <dt>{drop.what}</dt>
            <dd className="text-end text-muted-foreground">{drop.then}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

export function MoreWaysCard({ admin }: { admin: boolean }) {
  return (
    <SectionCard title="More ways in">
      <ul className="flex flex-col gap-2 text-sm">
        {admin && (
          <li className="flex flex-col">
            <Link className={LINK} href="/v2/data/sources">
              Sources and keys
            </Link>
            <span className="text-muted-foreground text-xs">Create or revoke the keys your servers use.</span>
          </li>
        )}
        <li className="flex flex-col">
          <Link className={LINK} href="/v2/data/monitoring">
            Monitoring
          </Link>
          <span className="text-muted-foreground text-xs">See events arrive, and what was dropped.</span>
        </li>
      </ul>
    </SectionCard>
  );
}
