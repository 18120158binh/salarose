"use client";

import { CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notify } from "@/shared/ui/v2/toast";

// Copies a fixed text, such as a code sample, and says the outcome in a toast.
export function CopyButton({ text, label = "Copy" }: { text: string | (() => string); label?: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "string" ? text : text());
      notify({ kind: "done", title: "Copied" });
    } catch {
      notify({ kind: "failed", title: "It could not be copied.", description: "Select it and copy it by hand." });
    }
  };
  return (
    <Button onClick={() => void copy()} size="sm" type="button" variant="outline">
      <CopyIcon aria-hidden />
      {label}
    </Button>
  );
}
