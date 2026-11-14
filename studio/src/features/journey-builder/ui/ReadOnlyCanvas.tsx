"use client";

import { useMemo } from "react";
import type { JourneyGraph } from "@/entities/journey/model/graphEdits";
import { formatCount } from "@/shared/lib/format";
import type { EventName } from "../model/labels";
import { CARD, layoutGraph } from "../model/layout";
import { branchTag, StepCardFace } from "./StepCard";

// JBD-FR-09: a published journey as the builder lays it out, with the same cards, and each step's
// all-time Completed count. Nothing on it adds, moves, opens, or removes a step.
export function ReadOnlyCanvas({
  graph,
  eventName,
  completed,
}: {
  graph: JourneyGraph;
  eventName: EventName;
  completed: Readonly<Record<string, number>>;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const byId = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );
  return (
    <div
      aria-label="Journey canvas"
      className="overflow-auto rounded-card border border-border bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_10%,transparent)_1px,transparent_1px)] bg-background bg-size-[18px_18px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      tabIndex={0}
    >
      <div
        className="relative mx-auto"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          aria-hidden
          className="absolute inset-0 text-muted-foreground/60"
          height={layout.height}
          width={layout.width}
        >
          <g fill="none" stroke="currentColor" strokeWidth={2}>
            {layout.edges.map((edge) => (
              <path d={edge.d} key={`${edge.from}-${edge.to}`} />
            ))}
          </g>
        </svg>
        {layout.edges.map((edge) => {
          const tag = edge.tag && branchTag(byId.get(edge.from), edge.type);
          return (
            tag &&
            edge.tag && (
              <span
                className="-translate-x-1/2 -translate-y-1/2 absolute rounded-full bg-secondary px-2 font-semibold text-[11px] text-secondary-foreground"
                key={`tag-${edge.from}-${edge.to}`}
                style={{ left: edge.tag.x, top: edge.tag.y }}
              >
                {tag}
              </span>
            )
          );
        })}
        <ul aria-label="Steps">
          {graph.nodes.map((node) => {
            const place = layout.nodes.get(node.id);
            if (!place) return null;
            return (
              <li
                className="absolute flex flex-col rounded-card border border-border bg-card px-3 py-2 text-foreground"
                key={node.id}
                style={{
                  left: place.x,
                  top: place.y,
                  width: CARD.width,
                  height: node.type === "end" ? CARD.endHeight : CARD.height,
                }}
              >
                <StepCardFace
                  aside={
                    <span className="text-xs">
                      <span className="text-muted-foreground">Completed </span>
                      <span className="font-heading font-semibold tabular-nums">
                        {formatCount(completed[node.id] ?? 0)}
                      </span>
                    </span>
                  }
                  eventName={eventName}
                  node={node}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
