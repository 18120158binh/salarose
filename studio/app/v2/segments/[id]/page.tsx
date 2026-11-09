import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { loadSegmentForEdit } from "@/features/segments/model/server";
import { SegmentEditor } from "@/features/segments/ui/SegmentEditor";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";

export const dynamic = "force-dynamic";

// SEG-FR-01, SEG-FR-07: one segment's editor, at stage preview, with where it is used.
export default async function EditSegmentPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, cookieStore] = await Promise.all([params, cookies()]);
  const data = await loadSegmentForEdit(decodeURIComponent(id), parseTimeZone(cookieStore.get(TZ_COOKIE)?.value));
  if (!data) notFound();
  return <SegmentEditor key={data.initial.id} {...data} />;
}
