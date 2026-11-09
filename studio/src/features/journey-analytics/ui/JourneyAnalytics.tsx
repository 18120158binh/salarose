import { RouteIcon } from "lucide-react";
import { formatCount, formatRate } from "@/shared/lib/format";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { RegionEmpty } from "@/shared/ui/v2/states";
import type { NodeAnalytics, RemovedStep } from "../model/queries";
import { BranchSplit, JourneyGraph } from "./JourneyGraph";

export interface JourneyAnalyticsProps {
  steps: readonly NodeAnalytics[];
  removed: readonly RemovedStep[];
  // The range the counts cover, such as "Last 7 days", for the removed steps' counts.
  rangeLabel: string;
}

// JBD-FR-19, JBD-FR-21: the current steps in a graph and a table, then the removed steps.
export function JourneyAnalytics({ steps, removed, rangeLabel }: JourneyAnalyticsProps) {
  return (
    <div className="flex flex-col gap-6">
      {steps.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <RegionEmpty icon={RouteIcon} message="This journey has no published steps." />
        </div>
      ) : (
        <>
          <JourneyGraph steps={steps} />
          <StepTable steps={steps} />
        </>
      )}
      <RemovedSteps rangeLabel={rangeLabel} removed={removed} />
      <p className="rounded-card border border-border bg-card px-4 py-3 text-muted-foreground text-sm">
        <b className="text-foreground">Not available:</b> messages delivered, opened or clicked, revenue, and goal conversion. Studio
        doesn&apos;t receive these yet, so it shows no number for them.
      </p>
    </div>
  );
}

const STEP_COLUMNS: readonly [Column<NodeAnalytics>, ...Column<NodeAnalytics>[]] = [
  {
    id: "step",
    header: "Step",
    // Indented by depth, so the table reads as the tree it is ordered by.
    cell: (step) => (
      <span className="block font-medium" style={{ paddingInlineStart: `${step.depth * 1.25}rem` }}>
        {step.label}
      </span>
    ),
  },
  { id: "entered", header: "Entered", kind: "number", cell: (step) => formatCount(step.entered) },
  { id: "waiting", header: "Waiting", kind: "number", cell: (step) => formatCount(step.waiting) },
  { id: "completed", header: "Completed", kind: "number", cell: (step) => formatCount(step.completed) },
  {
    id: "rate",
    header: "Completed of entered",
    kind: "number",
    cell: (step) =>
      formatRate({ numerator: step.completed, denominator: step.entered }) ?? <span className="text-muted-foreground">No entries</span>,
  },
  { id: "split", header: "Branch split", cell: (step) => <BranchSplit split={step.split} /> },
];

function StepTable({ steps }: { steps: readonly NodeAnalytics[] }) {
  return (
    <DataTable
      columns={STEP_COLUMNS}
      empty={null}
      label="Steps"
      rowKey={(step) => step.node.id}
      rows={steps}
    />
  );
}

function RemovedSteps({ removed, rangeLabel }: { removed: readonly RemovedStep[]; rangeLabel: string }) {
  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="cursor-pointer rounded-lg px-4 py-3 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Removed steps ({formatCount(removed.length)})
      </summary>
      <div className="border-border border-t px-4 py-3 text-sm">
        {removed.length === 0 ? (
          <p className="text-muted-foreground">No removed step has transitions.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {removed.map((step) => (
              <li className="flex items-baseline justify-between gap-4" key={step.nodeId}>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{step.label}</span>
                  <span className="font-mono text-muted-foreground text-xs">{step.nodeId}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatCount(step.entries)} <span className="text-muted-foreground">completed, {rangeLabel.toLowerCase()}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
