import { loadNewSegment } from "@/features/segments/model/server";
import { SegmentEditor } from "@/features/segments/ui/SegmentEditor";

export const dynamic = "force-dynamic";

// SEG-FR-01: a new segment, at stage preview.
export default async function NewSegmentPage() {
  const data = await loadNewSegment();
  return <SegmentEditor {...data} />;
}
