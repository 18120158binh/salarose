import * as db from "@/lib/db";
import { requireAdmin } from "@/shared/auth/session";
import AdminHeader from "@/widgets/admin-header/ui/AdminHeader";
import SourceKeysView from "@/features/data-ingestion/ui/SourceKeysView";

export const dynamic = "force-dynamic";

export default async function AdminSourceKeysPage() {
  await requireAdmin();
  const keys = await db.getSourceKeys();

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <AdminHeader />
      <div className="flex-1 overflow-y-auto p-8">
        <SourceKeysView keys={keys} />
      </div>
    </div>
  );
}
