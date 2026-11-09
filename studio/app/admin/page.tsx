import { redirect } from "next/navigation";

// The identity provider manages staff, so the admin console opens on the event catalog.
export default function AdminPage() {
  redirect("/admin/events");
}
