"use client";

import React from "react";
import AdminHeader from "@/widgets/admin-header/ui/AdminHeader";
import ManageEventsView from "@/features/event-management/ui/ManageEventsView";
import { UserEventPage } from "../types";

interface AdminPageClientProps {
  eventPage: UserEventPage;
}

export default function AdminPageClient({ eventPage }: AdminPageClientProps) {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <AdminHeader />
      <div className="flex-1 overflow-y-auto p-8">
        <ManageEventsView initialPage={eventPage} />
      </div>
    </div>
  );
}
