import type { ReactNode } from "react";
import type { CampaignNode } from "@/entities/journey/model/types";
import { getBranchOptions } from "@/entities/journey/model/utils";
import { cardText, type EventName } from "../model/labels";
import { StepIcon } from "./StepPanel";

// The face of one step: its icon, kind, label, and detail. The builder canvas and the read-only
// canvas of a published journey both draw it (JBD-FR-09), each in its own frame.
export function StepCardFace({
  node,
  eventName,
  aside,
}: {
  node: CampaignNode;
  eventName: EventName;
  aside?: ReactNode;
}) {
  const text = cardText(node, eventName);
  return (
    <>
      <span className="flex items-center gap-2">
        <StepIcon node={node} />
        <span className="font-semibold text-[10.5px] text-muted-foreground tracking-wider">
          {text.kind}
        </span>
        {aside && <span className="ms-auto flex gap-1">{aside}</span>}
      </span>
      <span className="mt-1 truncate font-semibold text-[13px]">
        {text.label}
      </span>
      {text.sub && (
        <span className="truncate text-muted-foreground text-xs">
          {text.sub}
        </span>
      )}
    </>
  );
}

// The tag on an edge from a step with more than one path, or null on its only path.
export function branchTag(
  parent: CampaignNode | undefined,
  type: string,
): string | null {
  if (!parent) return null;
  const label =
    getBranchOptions(parent).find((option) => option.value === type)?.label ??
    null;
  if (label === "Success") return "On success";
  if (label === "Timeout") return "On timeout";
  return label === "Next" ? null : label;
}
