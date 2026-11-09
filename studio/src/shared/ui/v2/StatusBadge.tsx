import type { ReactNode } from "react";
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, LoaderCircleIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Salarose: status is an icon and a word, never color alone. Journeys map Active to success,
// Paused to warning, and Draft to neutral.
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

const TONE: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheckIcon, className: "text-success" },
  warning: { icon: TriangleAlertIcon, className: "text-warning" },
  error: { icon: CircleXIcon, className: "text-destructive" },
  info: { icon: LoaderCircleIcon, className: "text-info" },
  neutral: { icon: CircleDashedIcon, className: "text-muted-foreground" },
};

export interface StatusBadgeProps {
  tone: StatusTone;
  children: ReactNode;
  // Replaces the tone's icon when a status needs a more specific one.
  icon?: LucideIcon;
}

export function StatusBadge({ tone, children, icon }: StatusBadgeProps) {
  const Icon = icon ?? TONE[tone].icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-xs", TONE[tone].className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}
