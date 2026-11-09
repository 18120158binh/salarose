import * as db from "@/lib/db";
import { requireAdmin } from "@/shared/auth/session";
import AdminPageClient from "./AdminPageClient";

export default async function AdminRoute() {
  await requireAdmin();
  const eventPage = await db.getUserEventSummariesPage();

  return <AdminPageClient eventPage={eventPage} />;
}
