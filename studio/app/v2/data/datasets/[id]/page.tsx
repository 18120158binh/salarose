import { cookies } from "next/headers";
import { isDatasetId } from "@/features/data-import/model/datasets";
import { loadDataset } from "@/features/data-import/model/datasetsServer";
import { DatasetEditor } from "@/features/data-import/ui/datasets/DatasetEditor";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { PageNotFound } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-01: an admin edits the dataset here. An editor reads the same page, read-only, and the
// save action refuses them too (DIM-FR-25).
export default async function V2DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await openRoute("datasets");
  if (!viewer) return null;
  const [{ id }, cookieStore] = await Promise.all([params, cookies()]);
  if (!isDatasetId(id)) return <PageNotFound />;
  const dataset = await loadDataset(id);
  if (dataset === null) return <PageNotFound />;
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  return <DatasetEditor dataset={dataset} key={dataset.version} mode="edit" readOnly={viewer.role !== "admin"} zone={zone} />;
}
