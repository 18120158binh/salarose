"use client";

import { RegionError } from "@/shared/ui/v2/states";

// The shell stays up when a page fails. The sentence is fixed, never the error's own text.
export default function V2Error({ unstable_retry }: { unstable_retry: () => void }) {
  return <RegionError message="This page could not load." onRetry={unstable_retry} />;
}
