"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

// PCN-FR-13: asks the server for the page again without reloading it. The server reuses each
// tool's check inside its window, so a quick second press calls no tool.
export function RecheckButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button disabled={disabled || pending} onClick={() => startTransition(() => router.refresh())} size="sm" variant="outline">
      <RefreshCwIcon aria-hidden className={pending ? "animate-spin" : undefined} />
      Re-check
    </Button>
  );
}
