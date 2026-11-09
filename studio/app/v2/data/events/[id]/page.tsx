import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeftIcon, DatabaseIcon, EyeOffIcon, LockIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { examplePayload } from "@/features/event-management/model/eventAttributeChange";
import { trackingName, type EventDetail } from "@/features/event-management/model/eventDetail";
import { loadEventDetail } from "@/features/event-management/model/eventDetailServer";
import { EventAttributeTable } from "@/features/event-management/ui/EventAttributeTable";
import {
  BuilderCard,
  EditEventDetailsDialog,
  FieldChangeRulesCard,
  RetireOrDeleteCard,
  StrictCard,
  type EventCampaignUseKind,
  type EventUseSummary,
} from "@/features/event-management/ui/EventDetailControls";
import { EventUsedBy } from "@/features/event-management/ui/EventUsedBy";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { liveHref } from "@/widgets/v2-shell/model/routes";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

function addedFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });
}

// A link inside /v2 only: a page that is not open to the viewer, or has no v2 page, gets no link.
function v2Href(href: string | null): string | null {
  return href !== null && href.startsWith("/v2") ? href : null;
}

type UsedCampaign = { id: string; name: string; status: string };

// Each journey once, with every way it uses the event.
function campaignUses(triggers: readonly UsedCampaign[], metrics: readonly UsedCampaign[]): EventUseSummary["campaigns"] {
  const byId = new Map<string, { id: string; name: string; status: string; kinds: EventCampaignUseKind[] }>();
  for (const [kind, list] of [["trigger", triggers], ["metric", metrics]] as const) {
    for (const campaign of list) {
      const entry = byId.get(campaign.id) ?? { ...campaign, kinds: [] };
      entry.kinds.push(kind);
      byId.set(campaign.id, entry);
    }
  }
  return [...byId.values()];
}

// CAT-FR-10, CAT-FR-20, DHL-FR-02: one event, with every change for an admin and the same content
// read-only for an editor. Every change goes through the event catalog's actions (DHL-FR-12),
// which check the admin role again on the server.
export default async function V2EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [viewer, reach, { id }] = await Promise.all([requireViewer(), viewerReach(), params]);
  const detail = await loadEventDetail(id);
  if (detail === null) return <EventNotFound />;
  const { event, uses, segments, fieldUses } = detail;
  const canEdit = viewer.role === "admin";
  const summary: EventUseSummary = { metrics: uses.metrics, campaigns: campaignUses(uses.conditionCampaigns, uses.metricCampaigns), segments };
  const name = trackingName(event.name);
  const added = addedFormat(parseTimeZone((await cookies()).get(TZ_COOKIE)?.value));
  const payload = examplePayload(event.attributes);

  return (
    <>
      <BackToEvents />
      <PageHeader
        actions={
          canEdit ? <EditEventDetailsDialog description={event.description} id={event.id} label={event.label} trackingName={name} /> : undefined
        }
        controls={<Tags event={event} />}
        description={<Facts added={added} event={event} name={name} />}
        preview
        title={event.label}
      />
      {!canEdit && (
        <p className="flex items-center gap-2 rounded-tile border border-border bg-card px-3.5 py-2.5 text-muted-foreground text-sm">
          <LockIcon aria-hidden className="size-4" />
          You can read this event, its fields and where it is used. Only admins can change it.
        </p>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_720px] flex-col gap-4">
          <EventAttributeTable
            attributes={event.attributes}
            canEdit={canEdit}
            eventId={event.id}
            eventLabel={event.label}
            fieldUses={fieldUses}
            strict={event.gate}
          />
          <SectionCard description="Built from the examples above" title={`What one ${event.label} looks like`}>
            {payload === "{}" ? (
              <p className="text-muted-foreground text-sm">No field has an example yet.</p>
            ) : (
              <pre className="overflow-x-auto rounded-tile bg-foreground px-4 py-3.5 font-mono text-background text-xs leading-relaxed">{payload}</pre>
            )}
          </SectionCard>
          <EventUsedBy metricsHref={v2Href(liveHref("metrics", reach))} uses={summary} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          <StrictCard
            canEdit={canEdit}
            id={event.id}
            label={event.label}
            monitoringHref={v2Href(liveHref("monitoring", reach))}
            on={event.gate}
            required={event.attributes.filter((attribute) => attribute.required).map((attribute) => attribute.path)}
          />
          <FieldChangeRulesCard />
          <BuilderCard active={event.status === "active"} canEdit={canEdit} id={event.id} label={event.label} />
          {canEdit && <RetireOrDeleteCard active={event.status === "active"} id={event.id} label={event.label} uses={summary} />}
        </aside>
      </div>
    </>
  );
}

function Tags({ event }: { event: EventDetail }) {
  if (!event.gate && event.status === "active") return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      {event.gate && (
        <span className="inline-flex items-center gap-1 font-semibold text-primary">
          <ShieldCheckIcon aria-hidden className="size-3" />
          Strict
        </span>
      )}
      {event.status === "inactive" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 font-semibold text-muted-foreground">
          <EyeOffIcon aria-hidden className="size-3" />
          Hidden from builder
        </span>
      )}
    </span>
  );
}

// The kind and a business event's item key are read-only for every viewer (CAT-FR-18).
function Facts({ event, name, added }: { event: EventDetail; name: string; added: Intl.DateTimeFormat }) {
  return (
    <span className="flex flex-col gap-2">
      {event.description !== null && <span className="max-w-2xl text-foreground">{event.description}</span>}
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          Tracking sends it as <span className="font-mono text-foreground">{name}</span>
        </span>
        {event.kind.kind === "person" ? (
          <span>Happens to one shopper, sent with their id</span>
        ) : (
          <span>
            Business event · Item key <span className="font-mono text-foreground">{event.kind.itemKey}</span>
          </span>
        )}
        {event.createdAt !== null && <span>Added {added.format(event.createdAt)}</span>}
      </span>
    </span>
  );
}

function BackToEvents() {
  return (
    <Link
      className="-mb-3 inline-flex w-fit items-center gap-1 rounded-sm text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      href="/v2/data/events"
    >
      <ArrowLeftIcon aria-hidden className="size-4" />
      All events
    </Link>
  );
}

function EventNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <RegionEmpty
        action={
          <Button render={<Link href="/v2/data/events" />} size="sm" variant="outline">
            Go to Events
          </Button>
        }
        icon={DatabaseIcon}
        message="This event is not in the catalog. It may have been deleted, or the link is wrong."
      />
    </div>
  );
}
