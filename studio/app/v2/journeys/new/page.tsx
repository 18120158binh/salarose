import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { parseModelConfig } from "@/app/api/generate-journey/modelConfig";
import { loadCatalogEvents } from "@/features/journeys/model/catalog";
import { NewJourney } from "@/features/journeys/ui/NewJourney";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { JOURNEY_NEW, stageLets } from "@/widgets/v2-shell/model/routes";
import { viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// JBD-FR-29: start a journey blank, from a template, or, when a model is configured, from a
// sentence. The route is at stage preview, so a viewer it does not let through gets not found
// before anything loads (SHL-FR-22).
export default async function V2NewJourneyPage() {
  const reach = await viewerReach();
  if (!stageLets(JOURNEY_NEW.stage, reach.preview)) notFound();
  const catalog = await loadCatalogEvents();

  return (
    <>
      <Link
        className="-mb-3 inline-flex w-fit items-center gap-1 rounded-sm text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        href="/v2/journeys"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Journeys
      </Link>
      <PageHeader
        description="Every start makes a draft that only you can see. You edit it in the builder, and nothing is sent to customers until you publish."
        preview={JOURNEY_NEW.stage === "preview"}
        title="Create journey"
      />
      <NewJourney aiConfigured={parseModelConfig(process.env) !== null} catalog={catalog} />
    </>
  );
}
