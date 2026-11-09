"use client";

import { Suspense, type ReactNode } from "react";
import { unstable_catchError, type ErrorInfo } from "next/error";
import { RegionError } from "./states";

function RegionFallback({ message }: { message: string }, { unstable_retry }: ErrorInfo) {
  return <RegionError message={message} onRetry={unstable_retry} />;
}

const RegionBoundary = unstable_catchError(RegionFallback);

export interface DataRegionProps {
  // What failed, in one fixed sentence, such as "Journey numbers could not load".
  errorMessage: string;
  // A skeleton with the loaded region's layout.
  loading: ReactNode;
  children: ReactNode;
}

// SHL-FR-12: each data region loads, fails, and retries on its own, so one region never blocks another.
export function DataRegion({ errorMessage, loading, children }: DataRegionProps) {
  return (
    <RegionBoundary message={errorMessage}>
      <Suspense fallback={loading}>{children}</Suspense>
    </RegionBoundary>
  );
}
