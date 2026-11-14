"use client";

import { useCallback, useMemo } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { graphFromRoot } from "@/features/journey-builder/model/builder";
import type { EventName } from "@/features/journey-builder/model/labels";
import type { CatalogEvent } from "@/features/journey-builder/ui/JourneyBuilder";
import { ReadOnlyCanvas } from "@/features/journey-builder/ui/ReadOnlyCanvas";
import { formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { RegionEmpty } from "@/shared/ui/v2/states";
import {
  refreshNodeCompletedAction,
  type NodeCompletedRefresh,
} from "../model/actions";
import { useNodeCompleted } from "../model/useNodeCompleted";

export interface JourneyCanvasTabProps {
  id: string;
  root: Record<string, unknown>;
  events: CatalogEvent[];
  completed: Record<string, number>;
  readAt: number;
  zone: TimeZone;
  /** The refresh action. Tests pass their own. */
  refresh?: (id: string) => Promise<NodeCompletedRefresh>;
}

// JBD-FR-09: the Journey tab of a published journey.
export function JourneyCanvasTab({
  id,
  root,
  events,
  completed,
  readAt,
  zone,
  refresh = refreshNodeCompletedAction,
}: JourneyCanvasTabProps) {
  const graph = useMemo(() => graphFromRoot(root), [root]);
  const eventName: EventName = useCallback(
    (name) =>
      name
        ? (events.find((event) => event.name === name)?.label ?? name)
        : null,
    [events],
  );
  const read = useCallback(() => refresh(id), [refresh, id]);
  const counts = useNodeCompleted({ completed, readAt }, read);

  if (graph === null)
    return (
      <RegionEmpty
        icon={TriangleAlertIcon}
        message="This journey can't be drawn. Its saved journey is not readable."
      />
    );

  const age = formatTimestamp(counts.readAt, counts.now, zone);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          Completed: all-time count of people who moved past each step.
        </span>
        {counts.stale ? (
          <span
            className="inline-flex items-center gap-1.5 text-warning"
            role="status"
          >
            <TriangleAlertIcon aria-hidden className="size-3.5" />
            Counts could not refresh. Showing counts from{" "}
            {age.text === "just now" ? "a few seconds ago" : age.text}.
          </span>
        ) : (
          <span className="text-muted-foreground" role="status">
            Updated {age.text} · refreshes every 5 seconds
          </span>
        )}
      </div>
      <ReadOnlyCanvas
        completed={counts.completed}
        eventName={eventName}
        graph={graph}
      />
    </div>
  );
}
