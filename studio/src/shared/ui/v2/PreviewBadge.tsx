import { cn } from "@/lib/utils";

// SHL-FR-22: marks a page, sidebar entry, or control whose area is at stage preview. Only preview
// viewers ever see it, because everyone else never gets the thing it marks.
export type PreviewBadgeOn = "surface" | "sidebar" | "primary";

const ON: Record<PreviewBadgeOn, string> = {
  surface: "border-preview-border bg-preview-tint text-preview",
  sidebar: "border-sidebar-ring/40 text-sidebar-ring",
  primary: "border-primary-foreground/50 text-primary-foreground",
};

export function PreviewBadge({ on = "surface", className }: { on?: PreviewBadgeOn; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 font-semibold text-[0.625rem] leading-4 tracking-[0.04em]",
        ON[on],
        className,
      )}
    >
      Preview
    </span>
  );
}
