"use client";

import { CopyButton } from "@/features/data-ingestion/ui/CopyButton";

export function CopyPageLink() {
  return <CopyButton label="Copy link for your developer" text={() => window.location.href} />;
}
