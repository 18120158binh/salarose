import * as db from "@/lib/db";
import { requireSession } from "@/shared/auth/session";
import Header from "@/shared/ui/Header";
import { SegmentsView } from "@/features/segments/ui/SegmentsView";
import { deleteSegmentAction, saveSegmentAction } from "../actions";

export const dynamic = "force-dynamic";

// SEG-NFR-02: every staff user with a session manages segments.
export default async function SegmentsPage() {
  const session = await requireSession();
  const [segments, events] = await Promise.all([db.listSegments(), db.getUserEvents()]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <Header currentView="segments" isAdminUser={session.role === "admin"} />
      <main className="flex-1 overflow-y-auto bg-background">
        <SegmentsView
          segments={segments}
          events={events}
          saveSegment={saveSegmentAction}
          deleteSegment={deleteSegmentAction}
        />
      </main>
    </div>
  );
}
