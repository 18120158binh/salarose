import { CircleCheckIcon, CircleXIcon, ClockIcon, MinusIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { StatusBadge, type StatusTone as BadgeTone } from "@/shared/ui/v2/StatusBadge";
import type { StatusTone } from "../../model/domain";

const BADGE: Record<StatusTone, { tone: BadgeTone; icon: LucideIcon }> = {
  ok: { tone: "success", icon: CircleCheckIcon },
  warn: { tone: "warning", icon: TriangleAlertIcon },
  bad: { tone: "error", icon: CircleXIcon },
  info: { tone: "info", icon: ClockIcon },
  off: { tone: "neutral", icon: MinusIcon },
};

/** A data import status as the boards draw it: an icon and a word, never color alone. */
export function ImportStatus({ tone, label, icon }: { tone: StatusTone; label: string; icon?: LucideIcon }) {
  return (
    <StatusBadge icon={icon ?? BADGE[tone].icon} tone={BADGE[tone].tone}>
      {label}
    </StatusBadge>
  );
}
