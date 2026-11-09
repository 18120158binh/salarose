"use client";

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCount } from "@/shared/lib/format";
import { graphRoots, type GraphNode } from "../model/graph";
import { branchLabel } from "../model/labels";
import type { NodeAnalytics } from "../model/queries";

// JBD-FR-19: the current steps as a tree, top down. Hover or keyboard focus on a step shows its
// branch split. The graph only reads: nothing on it moves or edits a step.
export function JourneyGraph({ steps }: { steps: readonly NodeAnalytics[] }) {
  return (
    <div
      aria-label="Journey graph"
      className="overflow-x-auto rounded-lg border border-border bg-card p-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      tabIndex={0}
    >
      <ul className="mx-auto flex w-max gap-10">
        {graphRoots(steps).map((root) => (
          <GraphBranch key={root.step.node.id} node={root} />
        ))}
      </ul>
    </div>
  );
}

function GraphBranch({ node }: { node: GraphNode }) {
  const { parentBranch } = node.step.node;
  return (
    <li className="flex flex-col items-center">
      {node.step.depth > 0 && parentBranch !== null && (
        <>
          <Stem />
          <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-muted-foreground text-xs">
            {branchLabel(parentBranch)}
          </span>
          <Stem />
        </>
      )}
      <StepCard step={node.step} />
      {node.children.length > 0 && (
        <>
          <Stem />
          <ul className="flex gap-6 border-border border-t">
            {node.children.map((child) => (
              <GraphBranch key={child.step.node.id} node={child} />
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

function Stem() {
  return <span aria-hidden className="h-4 w-px bg-border" />;
}

function StepCard({ step }: { step: NodeAnalytics }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`${step.label}: entered ${formatCount(step.entered)}, waiting ${formatCount(step.waiting)}, completed ${formatCount(step.completed)}; ${splitText(step.split)}`}
            className="w-56 rounded-lg border border-border bg-background p-3 text-left shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="group"
            tabIndex={0}
          />
        }
      >
        <p className="truncate font-medium text-sm" title={step.label}>
          {step.label}
        </p>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <Count label="Entered" value={step.entered} />
          <Count label="Waiting" value={step.waiting} />
          <Count label="Completed" value={step.completed} />
        </dl>
      </TooltipTrigger>
      <TooltipPopup>
        <BranchSplit split={step.split} />
      </TooltipPopup>
    </Tooltip>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground tabular-nums">{formatCount(value)}</dd>
    </div>
  );
}

function splitText(split: NodeAnalytics["split"]): string {
  if (split.length === 0) return "no branches";
  return `split ${split.map(({ branch, entries }) => `${branchLabel(branch)} ${formatCount(entries)}`).join(", ")}`;
}

export function BranchSplit({ split }: { split: NodeAnalytics["split"] }) {
  if (split.length === 0) return <span className="text-muted-foreground">No branches</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {split.map(({ branch, entries }) => (
        <li className="flex justify-between gap-4" key={branch}>
          <span>{branchLabel(branch)}</span>
          <span className="tabular-nums">{formatCount(entries)}</span>
        </li>
      ))}
    </ul>
  );
}
