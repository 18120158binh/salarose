"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { callServerAction } from "@/shared/lib/serverAction";
import { notify } from "@/shared/ui/v2/toast";

export interface ActionButtonProps {
  children: ReactNode;
  run: () => Promise<{ done: true } | { error: string }>;
  doneTitle: string;
  failedTitle: string;
  variant?: "default" | "outline" | "destructive-outline";
  size?: "default" | "sm";
  ariaLabel?: string;
}

/** Calls one server action, reports the outcome in a toast, and reloads the page's data. */
export function ActionButton({ children, run, doneTitle, failedTitle, variant = "outline", size = "sm", ariaLabel }: ActionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const click = () =>
    startTransition(async () => {
      const result = await callServerAction(run);
      if ("error" in result) {
        notify({ kind: "failed", title: failedTitle, description: result.error });
        return;
      }
      notify({ kind: "done", title: doneTitle });
      router.refresh();
    });
  return (
    <Button aria-label={ariaLabel} disabled={pending} onClick={click} size={size} variant={variant}>
      {children}
    </Button>
  );
}
