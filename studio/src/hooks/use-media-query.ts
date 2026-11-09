"use client";

import { useCallback, useSyncExternalStore } from "react";

// Tailwind's default breakpoints, so the shared sidebar's "max-md" means what its classes mean.
const BREAKPOINTS: Readonly<Record<string, number>> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

export function mediaQueryFor(query: string): string {
  const max = query.startsWith("max-");
  const width = BREAKPOINTS[max ? query.slice(4) : query];
  if (width === undefined) return query;
  return max ? `(max-width: ${width - 1}px)` : `(min-width: ${width}px)`;
}

// A breakpoint name such as "md" or "max-md", or a media query. False on the server and in a
// browser without matchMedia.
export function useMediaQuery(query: string): boolean {
  const media = mediaQueryFor(query);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(media);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [media],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(media).matches,
    () => false,
  );
}
