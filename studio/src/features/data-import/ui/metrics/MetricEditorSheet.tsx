"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { callServerAction } from "@/shared/lib/serverAction";
import { SideSheet } from "@/shared/ui/v2/SideSheet";
import { NotAvailable } from "@/shared/ui/v2/states";
import { notify } from "@/shared/ui/v2/toast";
import { METRIC_FUNCTION_COLUMN, METRIC_FUNCTIONS, type MetricFunction } from "../../model/domain";
import {
  columnRefusal,
  columnTypeLabel,
  FILTER_OP_LABELS,
  FILTER_OPS,
  METRIC_FUNCTION_LABELS,
  type DatasetMetric,
  type FilterOp,
  type MetricDataset,
} from "../../model/metrics";
import { createDatasetMetricAction, updateDatasetMetricAction } from "../../model/metricsActions";

const FIELD = "h-8 w-full rounded-control border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LABEL = "mb-1 block font-semibold text-xs";

interface FilterDraft {
  key: number;
  column: string;
  op: FilterOp;
  value: string;
}

interface Draft {
  datasetId: string;
  displayName: string;
  name: string;
  nameEdited: boolean;
  fn: MetricFunction;
  column: string;
  filters: FilterDraft[];
  windowDays: string;
  allTime: boolean;
}

/** "Spend, last 90 days" becomes `spend_last_90_days`, a valid system name. */
export function systemNameFrom(displayName: string): string {
  const base = displayName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base === "") return "";
  return /^[a-z]/.test(base) ? base : `m_${base}`;
}

function draftOf(metric: DatasetMetric | null, datasets: readonly MetricDataset[]): Draft {
  if (metric === null) {
    return {
      datasetId: datasets[0]?.id ?? "",
      displayName: "",
      name: "",
      nameEdited: false,
      fn: "COUNT",
      column: "",
      filters: [],
      windowDays: "90",
      allTime: false,
    };
  }
  return {
    datasetId: metric.dataset.id,
    displayName: metric.displayName,
    name: metric.name,
    nameEdited: true,
    fn: metric.function,
    column: metric.column ?? "",
    filters: metric.filters.map((filter, key) => ({ key, column: filter.column, op: filter.op, value: String(filter.value) })),
    windowDays: metric.windowDays === null ? "90" : String(metric.windowDays),
    allTime: metric.windowDays === null,
  };
}

export interface MetricEditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The metric to edit, or null to create one. */
  metric: DatasetMetric | null;
  datasets: readonly MetricDataset[];
}

export function MetricEditorSheet({ open, onOpenChange, metric, datasets }: MetricEditorSheetProps) {
  return (
    <SideSheet
      description={metric ? `Dataset metric · ${metric.dataset.displayName}` : "New dataset metric"}
      onOpenChange={onOpenChange}
      open={open}
      size="form"
      title={metric ? metric.displayName : "New dataset metric"}
    >
      {open && <MetricForm datasets={datasets} key={metric?.id ?? "new"} metric={metric} onDone={() => onOpenChange(false)} />}
    </SideSheet>
  );
}

function MetricForm({ metric, datasets, onDone }: { metric: DatasetMetric | null; datasets: readonly MetricDataset[]; onDone: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(metric, datasets));
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [nextKey, setNextKey] = useState(draft.filters.length);
  const dataset = datasets.find((candidate) => candidate.id === draft.datasetId) ?? null;
  const needs = METRIC_FUNCTION_COLUMN[draft.fn];
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  if (datasets.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No dataset of records exists yet. Create one on Datasets, with an event time, and its metrics can be made here.
      </p>
    );
  }

  const timeColumn = dataset?.columns.find((column) => column.name === dataset.eventTimeColumn)?.displayName ?? "event time";
  const field = dataset && draft.name !== "" ? `${dataset.name}.${draft.name}` : null;

  const save = () =>
    startTransition(async () => {
      const input = {
        recordTypeId: draft.datasetId,
        name: draft.name,
        displayName: draft.displayName,
        function: draft.fn,
        column: needs === "none" ? null : draft.column,
        filters: draft.filters.map(({ column, op, value }) => ({ column, op, value })),
        windowDays: draft.allTime ? null : draft.windowDays,
      };
      const result = await callServerAction<{ id: string } | { done: true } | { error: string; problems?: string[] }>(() =>
        metric ? updateDatasetMetricAction(metric.id, input) : createDatasetMetricAction(input),
      );
      if ("error" in result) {
        const listed = "problems" in result ? (result.problems ?? []) : [];
        setProblems(listed.length > 0 ? listed : [result.error]);
        return;
      }
      notify({ kind: "done", title: metric ? `Saved ${draft.displayName}` : `Created ${draft.displayName}` });
      router.refresh();
      onDone();
    });

  return (
    <form
      className="flex flex-col gap-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="metric-dataset">
            Dataset
          </label>
          <select
            className={FIELD}
            disabled={metric !== null}
            id="metric-dataset"
            onChange={(event) => update({ datasetId: event.target.value, column: "", filters: [] })}
            value={draft.datasetId}
          >
            {datasets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName}
              </option>
            ))}
          </select>
          <p className="mt-1 text-muted-foreground text-xs">
            Datasets with one row per record. Customer columns are already usable in conditions.
          </p>
        </div>
        <div>
          <label className={LABEL} htmlFor="metric-name">
            Name
          </label>
          <input
            className={FIELD}
            id="metric-name"
            onChange={(event) =>
              update({
                displayName: event.target.value,
                name: draft.nameEdited ? draft.name : systemNameFrom(event.target.value),
              })
            }
            value={draft.displayName}
          />
          <label className="mt-2 mb-1 block text-muted-foreground text-xs" htmlFor="metric-system-name">
            In conditions as
          </label>
          <input
            className={cn(FIELD, "font-mono")}
            id="metric-system-name"
            onChange={(event) => update({ name: event.target.value, nameEdited: true })}
            value={draft.name}
          />
          {field && dataset && (
            <p className="mt-1 text-muted-foreground text-xs">
              {dataset.displayName} &gt; {draft.displayName || "…"} · <span className="font-mono">{field}</span>
            </p>
          )}
        </div>
      </div>

      <fieldset>
        <legend className={LABEL}>Calculation</legend>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {METRIC_FUNCTIONS.map((fn) => {
            const on = draft.fn === fn;
            return (
              <button
                aria-pressed={on}
                className={cn(
                  "flex flex-col items-start rounded-control border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-primary/30 bg-primary/10 text-primary" : "border-input bg-background",
                )}
                key={fn}
                onClick={() => update({ fn })}
                type="button"
              >
                <b className="text-xs">{METRIC_FUNCTION_LABELS[fn].label}</b>
                <span className="text-muted-foreground text-xs">{METRIC_FUNCTION_LABELS[fn].hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="metric-column">
            Column
          </label>
          <select
            className={FIELD}
            disabled={needs === "none"}
            id="metric-column"
            onChange={(event) => update({ column: event.target.value })}
            value={needs === "none" ? "" : draft.column}
          >
            <option value="">{needs === "none" ? `${METRIC_FUNCTION_LABELS[draft.fn].label} takes no column` : "Pick a column"}</option>
            {needs !== "none" &&
              dataset?.columns.map((column) => {
                const refusal = columnRefusal(draft.fn, column);
                return (
                  <option disabled={refusal !== null} key={column.name} value={column.name}>
                    {column.displayName} · {columnTypeLabel(column.type)}
                    {refusal ? `, ${refusal}` : ""}
                  </option>
                );
              })}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="metric-window">
            Window
          </label>
          <div className="flex items-center gap-2">
            <input
              className={cn(FIELD, "w-20 font-heading tabular-nums")}
              disabled={draft.allTime}
              id="metric-window"
              inputMode="numeric"
              onChange={(event) => update({ windowDays: event.target.value })}
              value={draft.windowDays}
            />
            <span>days, by {timeColumn}</span>
            <label className="ml-auto flex items-center gap-1.5">
              <input checked={draft.allTime} className="accent-primary" onChange={(event) => update({ allTime: event.target.checked })} type="checkbox" />
              All time
            </label>
          </div>
        </div>
      </div>

      <div>
        <span className={LABEL}>Only count rows where</span>
        <div className="flex flex-col gap-2 rounded-tile border border-border p-2.5">
          {draft.filters.length === 0 && <p className="text-muted-foreground text-xs">Every row counts.</p>}
          {draft.filters.map((filter) => {
            const set = (patch: Partial<FilterDraft>) =>
              update({ filters: draft.filters.map((entry) => (entry.key === filter.key ? { ...entry, ...patch } : entry)) });
            return (
              <div className="flex flex-wrap items-center gap-2" key={filter.key}>
                <select aria-label="Filter column" className={cn(FIELD, "w-40")} onChange={(event) => set({ column: event.target.value })} value={filter.column}>
                  {dataset?.columns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.displayName}
                    </option>
                  ))}
                </select>
                <select aria-label="Filter operator" className={cn(FIELD, "w-32")} onChange={(event) => set({ op: event.target.value as FilterOp })} value={filter.op}>
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>
                      {FILTER_OP_LABELS[op]}
                    </option>
                  ))}
                </select>
                <input aria-label="Filter value" className={cn(FIELD, "w-36")} onChange={(event) => set({ value: event.target.value })} value={filter.value} />
                <Button
                  aria-label="Remove filter"
                  onClick={() => update({ filters: draft.filters.filter((entry) => entry.key !== filter.key) })}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden />
                </Button>
              </div>
            );
          })}
          <Button
            className="self-start"
            disabled={!dataset || dataset.columns.length === 0}
            onClick={() => {
              const first = dataset?.columns[0]?.name ?? "";
              update({ filters: [...draft.filters, { key: nextKey, column: first, op: "=", value: "" }] });
              setNextKey(nextKey + 1);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden />
            Add filter
          </Button>
        </div>
      </div>

      <section className="rounded-card border border-border bg-card p-3.5">
        <h3 className="font-semibold text-[0.8125rem]">Preview</h3>
        <div className="mt-2">
          <NotAvailable reason="Studio can't read the import store yet, so it can't show customers with a value, the lowest, the median, or the highest." />
        </div>
      </section>

      <p className="text-muted-foreground text-xs">
        Looking for &ldquo;days since last order&rdquo;? Make <b>Last order time</b> with Last time, then use &ldquo;more than 30 days ago&rdquo;
        in the condition.
      </p>

      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-tile border border-destructive/40 px-3 py-2 text-destructive text-xs" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2.5 border-border border-t pt-3.5">
        <span className="flex-1 text-muted-foreground text-xs">Conditions can use it after the next nightly pass, at 03:00.</span>
        <Button onClick={onDone} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={pending} type="submit">
          Save metric
        </Button>
      </div>
    </form>
  );
}
