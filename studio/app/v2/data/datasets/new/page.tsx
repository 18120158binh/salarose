import { cookies } from "next/headers";
import { DatasetEditor } from "@/features/data-import/ui/datasets/DatasetEditor";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { Forbidden } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-01: only an admin creates a dataset. An editor gets the forbidden state.
export default async function V2NewDatasetPage() {
  const viewer = await openRoute("datasets");
  if (viewer?.role !== "admin") return <Forbidden message="Only admins can create a dataset. You can read every dataset on Datasets." />;
  const zone = parseTimeZone((await cookies()).get(TZ_COOKIE)?.value);
  return <DatasetEditor mode="create" zone={zone} />;
}
