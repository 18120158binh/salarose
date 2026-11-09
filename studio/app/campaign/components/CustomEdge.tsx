import React from "react";
import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSmoothStepPath } from "@xyflow/react";

export type CustomEdgeProps = EdgeProps & {
  data?: {
    fromId: string;
    toId: string;
    onAddNodeBetween?: (fromId: string, toId: string) => void;
    label?: string;
  };
};

export default function CustomEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: CustomEdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {data && (
        <EdgeLabelRenderer>
          {data.label && (
            <div
              style={{
                position: "absolute",
                left: `${labelX}px`,
                top: `${labelY - 16}px`,
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
              className="text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground select-none whitespace-nowrap bg-background/80 backdrop-blur-xs px-1.5 py-0.5 rounded-sm border border-border/40 shadow-2xs z-30"
            >
              {data.label}
            </div>
          )}
          {data.onAddNodeBetween && (
            <div
              style={{
                position: "absolute",
                left: `${labelX}px`,
                top: `${labelY}px`,
                transform: "translate(-50%, -50%)",
                pointerEvents: "all",
              }}
              className="nodrag nopan z-30"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onAddNodeBetween?.(data.fromId, data.toId);
                }}
                title="Insert node here"
                className="w-7 h-7 rounded-full bg-background border border-border hover:border-primary/40 hover:bg-accent text-muted-foreground hover:text-foreground flex items-center justify-center font-bold text-sm shadow-md hover:scale-110 active:scale-95 transition-all cursor-pointer"
              >
                +
              </button>
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}
