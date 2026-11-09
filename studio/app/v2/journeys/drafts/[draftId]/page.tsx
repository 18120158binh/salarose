import Link from "next/link";
import { RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openDraft } from "@/features/journey-builder/model/server";
import { JourneyBuilder } from "@/features/journey-builder/ui/JourneyBuilder";
import { RegionEmpty } from "@/shared/ui/v2/states";

export const dynamic = "force-dynamic";

export default async function V2JourneyBuilderPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const draft = await openDraft(draftId);
  if (draft !== null) return <JourneyBuilder draft={draft} />;
  return (
    <div className="flex flex-1 items-center justify-center">
      <RegionEmpty
        action={
          <Button render={<Link href="/v2/journeys" />} size="sm" variant="outline">
            Go to Journeys
          </Button>
        }
        icon={RouteIcon}
        message="This journey does not exist."
      />
    </div>
  );
}
