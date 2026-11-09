import React from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { CampaignNode } from "@/entities/journey/model/types";
import { getIconBySubType } from "./Icons";
import { getConditionSummary } from "@/entities/journey/model/conditionConfig";
import type { BranchConfig } from "@/entities/journey/model/utils";

export type CustomNodeProps = NodeProps & {
  data: {
    node: CampaignNode;
    isSelected: boolean;
    onSelect: (id: string) => void;
    userCount?: number;
  };
};

// Static styling maps for O(1) lookup and memory efficiency
const SUBTYPE_COLORS: Record<string, string> = {
  setup: "border-orange-400 bg-orange-50/50 dark:bg-orange-950/20 text-orange-600 dark:text-orange-400",
  watch: "border-orange-400 bg-orange-50/50 dark:bg-orange-950/20 text-orange-600 dark:text-orange-400",
  decision: "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20 text-sky-600 dark:text-sky-400",
  check: "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20 text-sky-600 dark:text-sky-400",
  step: "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20 text-sky-600 dark:text-sky-400",
  fallback: "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20 text-sky-600 dark:text-sky-400",
  segment: "border-violet-400 bg-violet-50/50 dark:bg-violet-950/20 text-violet-600 dark:text-violet-400",
  wait: "border-slate-400 bg-slate-50/50 dark:bg-slate-950/20 text-slate-600 dark:text-slate-400",
  end: "border-slate-400 bg-slate-50/50 dark:bg-slate-950/20 text-slate-600 dark:text-slate-400",
};
const DEFAULT_SUBTYPE_COLOR = "border-teal-400 bg-teal-50/50 dark:bg-teal-950/20 text-teal-600 dark:text-teal-400";

const CONTAINER_STYLES: Record<string, { selected: string; default: string }> = {
  watch: {
    selected: "border-orange-500 bg-orange-50/40 dark:bg-orange-950/20 ring-2 ring-orange-500/20 shadow-lg",
    default: "border-orange-300/80 bg-orange-50/20 dark:border-orange-500/30 dark:bg-orange-950/10"
  },
  check: {
    selected: "border-sky-500 bg-sky-50/40 dark:bg-sky-950/20 ring-2 ring-sky-500/20 shadow-lg",
    default: "border-sky-300/80 bg-sky-50/20 dark:border-sky-500/30 dark:bg-sky-950/10"
  },
  segment: {
    selected: "border-violet-500 bg-violet-50/40 dark:bg-violet-950/20 ring-2 ring-violet-500/20 shadow-lg",
    default: "border-violet-300/80 bg-violet-50/20 dark:border-violet-500/30 dark:bg-violet-950/10"
  },
  engagement: {
    selected: "border-teal-500 bg-teal-50/30 dark:bg-teal-950/20 ring-2 ring-teal-500/20 shadow-lg",
    default: "border-teal-300/70 bg-teal-50/10 dark:border-teal-500/20 dark:bg-teal-950/5"
  },
  end: {
    selected: "border-slate-500 bg-slate-100/60 dark:bg-slate-800/40 ring-2 ring-slate-500/20 shadow-lg",
    default: "border-slate-300/80 bg-slate-50/30 dark:border-slate-700/30 dark:bg-slate-900/30"
  }
};
const DEFAULT_CONTAINER_STYLE = {
  selected: "border-primary bg-accent/30 ring-2 ring-primary/10 shadow-lg",
  default: "border-border bg-card"
};

export default function CustomNode({ data }: CustomNodeProps) {
  const { node, isSelected, onSelect } = data;

  const nodeWidth = 220;
  const nodeHeight = 76;

  const getSubtypeIcon = (subType: string) => {
    return getIconBySubType(subType, "w-5 h-5") || <span>📦</span>;
  };

  const colorClass = SUBTYPE_COLORS[node.type] || DEFAULT_SUBTYPE_COLOR;
  
  const containerStyleDef = CONTAINER_STYLES[node.type] || DEFAULT_CONTAINER_STYLE;
  const containerStyleClass = isSelected ? containerStyleDef.selected : containerStyleDef.default;

  // Determine handles based on node type
  const hasTarget = node.type !== "setup";
  const hasSource = node.type !== "end";

  const isCombined =
    (node.type === "check" && node.config.checkType === "YesOrNoPath") ||
    // A segment always has Yes. An older one may also keep a No path, even a No Only one.
    (node.type === "segment" && ["YesOrNoPath", "NoPath"].includes(node.config.checkType)) ||
    (node.type === "watch" && node.config.watchType === "SuccessOrTimeoutPath");

  const isOnlyYes =
    (node.type === "check" && node.config.checkType === "YesPath") ||
    (node.type === "segment" && node.config.checkType === "YesPath") ||
    (node.type === "watch" && node.config.watchType === "SuccessPath");

  const isOnlyNo =
    (node.type === "check" && node.config.checkType === "NoPath") ||
    (node.type === "watch" && node.config.watchType === "TimeoutPath");

  const isDelayOnly = node.type === "watch" && node.config.watchType === "DelayPath";
  const isMultiBranch = node.type === "check" && node.config.checkType === "MultiBranchPath";

  const yesLabel = node.type === "watch" ? "Success" : "Yes";
  const noLabel = node.type === "watch" ? "Timeout" : "No";

  if (node.type === "setup") {
    return (
      <div
        onClick={() => onSelect(node.id)}
        style={{
          width: `${nodeWidth}px`,
          height: `${nodeHeight}px`,
        }}
        className={`rounded-xl border-2 p-3 flex items-center justify-between cursor-pointer transition-all duration-200 select-none hover:shadow-md shadow-xs ${
          isSelected
            ? "border-orange-500 bg-orange-50/40 dark:bg-orange-950/20 ring-2 ring-orange-500/20 shadow-lg"
            : "border-orange-300/80 bg-orange-50/20 dark:border-orange-500/30 dark:bg-orange-950/10"
        }`}
      >
        <div className="flex items-center gap-3 overflow-hidden w-full">
          <div className="flex flex-col text-left overflow-hidden w-full">
            <span className="text-[10px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wider leading-none">
              Entry Trigger
            </span>
            <span className="text-xs font-bold text-foreground leading-snug truncate mt-1">
              {node.label}
            </span>
            <span className="text-[10px] text-muted-foreground leading-normal truncate font-medium">
              {node.config.triggerEventName || node.config.eventName 
                ? `Triggered on: ${node.config.triggerEventName || node.config.eventName}` 
                : (node.config.description || "Define journey settings")}
            </span>
          </div>
        </div>

        {/* Sticking out Setup/Entry Icon */}
        <div className="w-9 h-9 rounded-lg border-2 border-orange-500 bg-orange-500 flex items-center justify-center shrink-0 translate-x-2.5 shadow-sm text-white">
          {getSubtypeIcon("setup")}
        </div>

        {/* Source Handle (Right) */}
        {hasSource && (
          <div className="absolute top-1/2 -right-[9px] -translate-y-1/2 w-[18px] h-[18px] z-20 group">
            <div className="w-full h-full rounded-md border border-border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center justify-center shadow-xs hover:border-primary/40 hover:bg-accent transition-all duration-200">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <Handle
              type="source"
              position={Position.Right}
              id="yes"
              className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
              style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
            />
          </div>
        )}

        {/* User Count Badge */}
        {data.userCount !== undefined && (
          <div className="absolute -top-3 right-4 bg-indigo-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm border border-indigo-400/20 z-30 flex items-center gap-1 cursor-default">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
               <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
            {data.userCount.toLocaleString()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect(node.id)}
      style={{
        width: `${nodeWidth}px`,
        height: `${nodeHeight}px`,
      }}
      className={`rounded-xl border-2 p-3.5 flex items-center justify-between cursor-pointer transition-all duration-200 select-none hover:shadow-md shadow-xs ${containerStyleClass}`}
    >
      {/* Target Handle (Left) */}
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-border !border-2 !border-background !w-3 !h-3 hover:!bg-primary transition-colors"
          style={{ left: "-6px" }}
        />
      )}

      <div className="flex items-center gap-3 overflow-hidden w-full">
        <div className={`w-9 h-9 rounded-lg border flex items-center justify-center text-lg ${colorClass} shrink-0`}>
          {getSubtypeIcon(node.subType)}
        </div>
        <div className="flex flex-col text-left overflow-hidden w-full">
          <span className="text-xs font-bold text-foreground leading-snug truncate">
            {node.label}
          </span>
          <span className="text-[10px] text-muted-foreground leading-normal truncate">
            {node.type === "check" 
              ? getConditionSummary(node.config.filters) || node.config.description || "Configure conditions"
              : isDelayOnly
              ? `Delay ${node.config.timeLimitValue ?? 15} ${node.config.timeLimitUnit || "minutes"}`
              : node.type === "watch" && node.config.eventName
              ? `Event: ${node.config.eventName}`
              : node.config.description || node.config.title || node.config.body || node.config.subject || node.subType}
          </span>
        </div>
      </div>
      {/* Custom Source Handles for Decision and Watch Nodes */}
      {isCombined && (
        <div className="absolute top-1/2 -right-[11px] -translate-y-1/2 w-[22px] h-[22px] z-20 group">
          {/* Combined Diamond Handle */}
          <div 
            className="w-full h-full rotate-45 border border-background shadow-xs hover:scale-110 active:scale-95 transition-all duration-200"
            style={{ background: 'linear-gradient(135deg, #10b981 50%, #f43f5e 50%)' }}
          />
          {/* Branching icon overlaid on the diamond */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 text-white select-none">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19v-6" />
              <path d="M12 13c-2 0-3-1-4-3" />
              <path d="M12 13c2 0 3-1 4-3" />
              <circle cx="8" cy="9" r="1" fill="currentColor" />
              <circle cx="16" cy="9" r="1" fill="currentColor" />
            </svg>
          </div>
          {/* Invisible React Flow Handles */}
          <Handle
            type="source"
            position={Position.Right}
            id="yes"
            className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
            style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="no"
            className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
            style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
          />
          {/* Outside Labels */}
          <span className="absolute left-[20px] -top-[14px] text-[9px] font-extrabold text-emerald-500 dark:text-emerald-400 select-none pointer-events-none uppercase tracking-wider whitespace-nowrap bg-background px-1.5 py-0.5 rounded shadow-2xs border border-border/20 z-30">
            {yesLabel}
          </span>
          <span className="absolute left-[20px] -bottom-[14px] text-[9px] font-extrabold text-rose-500 dark:text-rose-400 select-none pointer-events-none uppercase tracking-wider whitespace-nowrap bg-background px-1.5 py-0.5 rounded shadow-2xs border border-border/20 z-30">
            {noLabel}
          </span>
        </div>
      )}

      {isOnlyYes && (
        <div className="absolute top-1/2 -right-[11px] -translate-y-1/2 w-[22px] h-[22px] z-20 group">
          {/* Yes Square Handle */}
          <div className="w-full h-full rounded-md border border-background bg-emerald-500 flex items-center justify-center shadow-xs hover:scale-110 active:scale-95 transition-all duration-200 text-white">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          {/* Invisible React Flow Handle */}
          <Handle
            type="source"
            position={Position.Right}
            id="yes"
            className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
            style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
          />
          {/* Outside Label */}
          <span className="absolute left-[20px] -top-[14px] text-[9px] font-extrabold text-emerald-500 dark:text-emerald-400 select-none pointer-events-none uppercase tracking-wider whitespace-nowrap bg-background px-1.5 py-0.5 rounded shadow-2xs border border-border/20 z-30">
            {yesLabel}
          </span>
        </div>
      )}

      {isOnlyNo && (
        <div className="absolute top-1/2 -right-[11px] -translate-y-1/2 w-[22px] h-[22px] z-20 group">
          {/* No Square Handle */}
          <div className="w-full h-full rounded-md border border-background bg-rose-500 flex items-center justify-center shadow-xs hover:scale-110 active:scale-95 transition-all duration-200 text-white">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
          {/* Invisible React Flow Handle */}
          <Handle
            type="source"
            position={Position.Right}
            id="no"
            className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
            style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
          />
          {/* Outside Label */}
          <span className="absolute left-[20px] -bottom-[14px] text-[9px] font-extrabold text-rose-500 dark:text-rose-400 select-none pointer-events-none uppercase tracking-wider whitespace-nowrap bg-background px-1.5 py-0.5 rounded shadow-2xs border border-border/20 z-30">
            {noLabel}
          </span>
        </div>
      )}

      {/* Multi-Branch Handles */}
      {isMultiBranch && node.config.branches && (
        <div className="absolute top-1/2 -right-[11px] -translate-y-1/2 w-[22px] h-[22px] z-20 group">
          {/* Unified Branching Diamond */}
          <div 
            className="w-full h-full rotate-45 border border-background shadow-xs hover:scale-110 active:scale-95 transition-all duration-200"
            style={{ background: 'linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%)' }}
          />
          {/* Branching icon overlaid on the diamond */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 text-white select-none">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
          {/* Stack all branch handles exactly on top of each other */}
          {(node.config.branches as BranchConfig[]).map((b) => (
            <Handle
              key={b.branchKey}
              type="source"
              position={Position.Right}
              id={b.branchKey}
              className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
              style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
            />
          ))}
        </div>
      )}

      {/* Non-branching nodes, including DelayPath watches, have one Next output. */}
      {((node.type !== "check" && node.type !== "segment" && node.type !== "watch") || isDelayOnly)
        && !isMultiBranch && hasSource && (
        <div className="absolute top-1/2 -right-[9px] -translate-y-1/2 w-[18px] h-[18px] z-20 group">
          <div className="w-full h-full rounded-md border border-border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center justify-center shadow-xs hover:border-primary/40 hover:bg-accent transition-all duration-200">
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
          <Handle
            type="source"
            position={Position.Right}
            id="yes"
            className="!opacity-0 !w-full !h-full !border-0 !bg-transparent"
            style={{ top: '50%', right: '50%', transform: 'translate(50%, -50%)' }}
          />
        </div>
      )}

      {/* User Count Badge */}
      {data.userCount !== undefined && (
        <div className="absolute -top-3 right-4 bg-indigo-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm border border-indigo-400/20 z-30 flex items-center gap-1 cursor-default">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
             <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
          {data.userCount.toLocaleString()}
        </div>
      )}

      {/* Hexagon Stopwatch loop decoration at the bottom */}
      {node.type === "watch" && (
        <div className="absolute -bottom-8.5 left-1/2 -translate-x-1/2 flex flex-col items-center z-10 pointer-events-none">
          {/* Double-arrow loop line behind the hexagon */}
          <svg className="absolute -top-3 w-10 h-6 overflow-visible text-muted-foreground/30 dark:text-muted-foreground/20" fill="none">
            <path
              d="M 5,0 Q 5,16 20,16 Q 35,16 35,0"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="3,3"
            />
          </svg>
          {/* Hexagon badge with stopwatch */}
          <div
            className="relative w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 shadow-sm"
            style={{
              clipPath: "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)",
            }}
          >
            {getSubtypeIcon("wait")}
          </div>
          {/* Duration pill badge */}
          <div className="mt-1.5 bg-orange-500 text-white text-[8px] font-extrabold px-1.5 py-0.5 rounded-full border border-orange-400/20 shadow-sm whitespace-nowrap">
            {node.config.timeLimitValue !== undefined ? node.config.timeLimitValue : 15} {node.config.timeLimitUnit === "minutes" ? "Mins" : node.config.timeLimitUnit === "hours" ? "Hours" : node.config.timeLimitUnit === "days" ? "Days" : "Secs"}
          </div>
        </div>
      )}
    </div>
  );
}
