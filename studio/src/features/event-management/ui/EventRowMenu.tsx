"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { callServerAction } from "@/shared/lib/serverAction";
import { notify } from "@/shared/ui/v2/toast";
import { setEventStatusAction } from "../model/actions";
import { eventDetailHref } from "../model/eventDetail";

type RowEvent = { readonly id: string; readonly label: string; readonly status: "active" | "inactive" };

/**
 * CAT-FR-10: an admin's row menu on the Events list. Hide from builder switches the status in place.
 * Edit details and Delete open the event's page, where the edit form and the delete check with the
 * event's uses already live.
 */
export function EventRowMenu({ event }: { event: RowEvent }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hidden = event.status === "inactive";
  const href = eventDetailHref(event.id);

  const toggle = () =>
    startTransition(async () => {
      const result = await callServerAction(() => setEventStatusAction(event.id, hidden ? "active" : "inactive"));
      if ("error" in result) {
        notify({ kind: "failed", title: `${event.label} was not changed.`, description: result.error });
        return;
      }
      notify({ kind: "done", title: hidden ? `${event.label} shows in the builder.` : `${event.label} is hidden from the builder.` });
      router.refresh();
    });

  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label={`More actions for ${event.label}: edit details, hide from builder, delete`} disabled={pending} size="icon-sm" variant="ghost" />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem render={<Link href={href} />}>Edit details</MenuItem>
        <MenuItem onClick={toggle}>{hidden ? "Show in builder" : "Hide from builder"}</MenuItem>
        <MenuItem render={<Link href={href} />} variant="destructive">
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
