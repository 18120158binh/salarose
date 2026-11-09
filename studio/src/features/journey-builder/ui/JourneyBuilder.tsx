"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  Redo2Icon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { isBranchingType, stepsBelow, updateNodeConfig } from "@/entities/journey/model/graphEdits";
import { validateJourney } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import type { CampaignNode } from "@/entities/journey/model/types";
import { getBranchOptions } from "@/entities/journey/model/utils";
import { publishDraftAction, saveDraftAction } from "@/features/journeys/model/actions";
import type { PublishResult } from "@/features/journeys/model/drafts";
import { cn } from "@/lib/utils";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { builderReducer, graphFromRoot, initialState, isSaved, rootOfGraph, type BuilderState, type InsertAt } from "../model/builder";
import { buildChecklist, journeySummary, type Checklist } from "../model/checklist";
import { cardText, type EventName } from "../model/labels";
import { CARD, layoutGraph } from "../model/layout";
import { paletteEntries, PALETTE_GROUPS, type PaletteEntry } from "../model/palette";
import { useAutosave, type SaveDraft } from "../model/useAutosave";
import { ChecklistDrawer } from "./Checklist";
import { ReviewDialog, type PublishFlow } from "./ReviewDialog";
import { StepIcon, StepPanel, type Confirm } from "./StepPanel";

export interface CatalogEvent {
  name: string;
  label: string;
}

export interface BuilderDraft {
  id: string;
  name: string;
  description: string;
  version: number;
  root: Record<string, unknown>;
  savedAt: number;
  events: CatalogEvent[];
}

/** The publish action, as the builder calls it. */
export type PublishDraft = (input: { draftId: string; version: number; asNewJourney: boolean }) => Promise<PublishResult | { error: string }>;

export interface JourneyBuilderProps {
  draft: BuilderDraft;
  /** The draft save and publish actions. Tests pass their own. */
  save?: SaveDraft;
  publish?: PublishDraft;
}

// JBD-FR-01, 02, 07, 10, 22, 26, 42: the v2 builder for one draft, as the JourneyBuilder board
// draws it, with the checklist drawer and the review dialog of the JourneyPublish board (JBD-FR-25, 27).
export function JourneyBuilder({ draft, save = saveDraftAction, publish = publishDraftAction }: JourneyBuilderProps) {
  const graph = useMemo(() => graphFromRoot(draft.root), [draft.root]);
  if (graph === null) {
    return <RegionEmpty icon={TriangleAlertIcon} message="This draft can't be opened. Its saved journey is not readable." />;
  }
  return <Builder draft={draft} graph={graph} publish={publish} save={save} />;
}

function Builder({
  draft,
  graph,
  save,
  publish,
}: { draft: BuilderDraft; graph: NonNullable<ReturnType<typeof graphFromRoot>>; save: SaveDraft; publish: PublishDraft }) {
  const [state, dispatch] = useReducer(builderReducer, { ...draft, graph }, initialState);
  const [target, setTarget] = useState<InsertAt | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useAutosave(state, dispatch, save);
  useLeavePrompt(state.revision !== state.savedRevision);

  const eventName: EventName = useCallback(
    (name) => (name ? (draft.events.find((event) => event.name === name)?.label ?? name) : null),
    [draft.events],
  );
  const problems = useMemo(() => {
    try {
      return validateJourney(rootOfGraph(state.graph), RUNTIME_REGISTRY).problems;
    } catch {
      return [];
    }
  }, [state.graph]);

  const add = (entry: PaletteEntry, at: InsertAt | null) => {
    if (entry.key === "event-trigger") {
      dispatch({ type: "select", nodeId: state.graph.nodes.find((n) => n.type === "setup")?.id ?? null });
      return;
    }
    if (!entry.item) return;
    dispatch({ type: "add", item: entry.item, at, stamp: Date.now() });
    setTarget(null);
  };

  const requestRemove = (node: CampaignNode) => {
    if (node.type === "setup" || node.type === "end") return;
    if (!isBranchingType(node.type, node.config)) {
      dispatch({ type: "remove", nodeId: node.id });
      return;
    }
    const below = stepsBelow(state.graph, node.id);
    setConfirm({
      title: `Remove ${cardText(node, eventName).label}?`,
      description: `Removes this step and the ${below} below it.`,
      action: "Remove step",
      run: () => dispatch({ type: "remove", nodeId: node.id }),
    });
  };

  const configure = (node: CampaignNode, config: CampaignNode["config"]) => {
    const stamp = Date.now();
    const removed = removedSteps(state, node.id, config, stamp);
    const apply = () => dispatch({ type: "configure", nodeId: node.id, config, stamp });
    if (removed === 0) {
      apply();
      return;
    }
    setConfirm({
      title: "Remove a branch?",
      description: `This removes a branch and its ${removed} step${removed === 1 ? "" : "s"}.`,
      action: "Remove branch",
      run: apply,
    });
  };

  const catalog = useMemo(() => new Set(draft.events.map((event) => event.name)), [draft.events]);
  const checklist = useMemo(() => buildChecklist(problems, state.graph, catalog, eventName), [problems, state.graph, catalog, eventName]);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const closeChecklist = useCallback(() => setChecklistOpen(false), []);
  const { flow, setFlow, startPublish, unsavedReason } = usePublish(state, publish);

  const goTo = (nodeId: string) => {
    setChecklistOpen(false);
    dispatch({ type: "select", nodeId });
    requestAnimationFrame(() => document.getElementById(`step-${nodeId}`)?.focus());
  };

  const selected = state.graph.nodes.find((n) => n.id === state.selected) ?? null;

  return (
    <div className="-m-6 min-[1440px]:-m-8 flex min-h-[640px] flex-1 flex-col bg-background">
      <Header
        checklist={checklist}
        checklistOpen={checklistOpen}
        dispatch={dispatch}
        onChecklist={() => setChecklistOpen((open) => !open)}
        onPublish={() => setFlow({ kind: "review" })}
        state={state}
      />
      <Banner dispatch={dispatch} state={state} />
      <div className="flex min-h-0 flex-1">
        <Palette onAdd={add} target={target} onClearTarget={() => setTarget(null)} />
        <Canvas
          eventName={eventName}
          onAddAt={setTarget}
          onDrop={add}
          onRemove={requestRemove}
          onSelect={(id) => dispatch({ type: "select", nodeId: id })}
          problems={problems}
          state={state}
          target={target}
        />
        {checklistOpen && <ChecklistDrawer checklist={checklist} onClose={closeChecklist} onGoTo={goTo} />}
        {selected && !checklistOpen && (
          <StepPanel
            events={draft.events}
            eventName={eventName}
            graph={state.graph}
            node={selected}
            onClose={() => dispatch({ type: "select", nodeId: null })}
            onChannel={(channel) => dispatch({ type: "channel", nodeId: selected.id, channel })}
            onConfigure={(config) => configure(selected, config)}
            onRemove={() => requestRemove(selected)}
            onConfirm={setConfirm}
          />
        )}
      </div>
      <ReviewDialog
        checklist={checklist}
        flow={flow}
        name={state.name}
        onClose={() => setFlow({ kind: "closed" })}
        onLoadLatest={() => window.location.reload()}
        onPublish={startPublish}
        onShowChecklist={() => {
          setFlow({ kind: "closed" });
          setChecklistOpen(true);
        }}
        summary={journeySummary(state.graph, eventName)}
        unsavedReason={unsavedReason}
      />
      <AlertDialog onOpenChange={(open) => !open && setConfirm(null)} open={confirm !== null}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose onClick={() => confirm?.run()} render={<Button variant="destructive" />}>
              {confirm?.action}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

// The steps, End steps aside, that a config change would delete with a removed branch.
function removedSteps(state: BuilderState, nodeId: string, config: CampaignNode["config"], stamp: number): number {
  const result = updateNodeConfig(state.graph, { nodeId, config, stamp });
  if (!result?.pathsChanged) return 0;
  const kept = new Set(result.graph.nodes.map((n) => n.id));
  return state.graph.nodes.filter((n) => n.type !== "end" && !kept.has(n.id)).length;
}

// JBD-FR-27: publish sends the stored draft, so Publish journey first waits for autosave to hold
// every edit, then names the version it saved. Each refusal of the action keeps the dialog open.
function usePublish(state: BuilderState, publish: PublishDraft) {
  const router = useRouter();
  const [flow, setFlow] = useState<PublishFlow>({ kind: "closed" });
  const sent = useRef(false);
  const saved = isSaved(state) && state.save.kind === "saved";
  const unsavedReason =
    state.save.kind === "conflict" || state.save.kind === "stale"
      ? "This draft changed somewhere else. Resolve it in the builder first."
      : state.save.kind === "failed"
        ? "Your last edit is not saved. Retry the save first."
        : null;

  useEffect(() => {
    if (flow.kind !== "busy" || !saved || sent.current) return;
    sent.current = true;
    const { asNewJourney } = flow;
    const settle = (next: PublishFlow) => {
      sent.current = false;
      setFlow(next);
    };
    publish({ draftId: state.id, version: state.version, asNewJourney })
      .then((result) => {
        if ("error" in result) return settle({ kind: "failed", message: result.error });
        switch (result.status) {
          case "published":
          case "already_published":
            router.push(`/v2/journeys/${encodeURIComponent(result.campaignId)}`);
            return;
          case "collision":
            return settle({ kind: "collision" });
          case "draft_missing":
            return settle({ kind: "missing" });
          case "stale":
            return settle({ kind: "stale" });
          case "invalid":
            return settle({ kind: "failed", message: "Publishing found a problem that blocks it. Open the checklist and fix it." });
        }
      })
      .catch(() => settle({ kind: "failed", message: "Failed to publish the journey." }));
  }, [flow, saved, publish, router, state.id, state.version]);

  // A save that fails while publish waits for it ends the wait.
  const shown: PublishFlow = flow.kind === "busy" && unsavedReason !== null ? { kind: "failed", message: unsavedReason } : flow;
  const startPublish = (asNewJourney: boolean) => setFlow({ kind: "busy", asNewJourney });
  return { flow: shown, setFlow, startPublish, unsavedReason };
}

// Contract: leaving with unsaved edits shows the browser's leave-page prompt.
function useLeavePrompt(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
}

type Dispatch = React.Dispatch<Parameters<typeof builderReducer>[1]>;

interface HeaderProps {
  state: BuilderState;
  dispatch: Dispatch;
  checklist: Checklist;
  checklistOpen: boolean;
  onChecklist: () => void;
  onPublish: () => void;
}

function Header({ state, dispatch, checklist, checklistOpen, onChecklist, onPublish }: HeaderProps) {
  const count = checklist.blocks + checklist.warnings;
  const blocking = checklist.blocks > 0;
  const warnings = `${checklist.warnings} warning${checklist.warnings === 1 ? "" : "s"}`;
  const aria = blocking
    ? `Checklist: ${checklist.blocks} problem${checklist.blocks === 1 ? " blocks" : "s block"} publishing, ${warnings}`
    : `Checklist: nothing blocks publishing, ${warnings}`;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const field = event.target as HTMLElement | null;
      if (field?.closest("input, textarea, select")) return;
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-border border-b bg-card px-6 py-2.5">
      <Button aria-label="Back to Journeys" render={<Link href="/v2/journeys" />} size="icon" title="Back to Journeys" variant="outline">
        <ArrowLeftIcon aria-hidden />
      </Button>
      <label className="flex items-center gap-1.5 rounded-control px-1.5 focus-within:ring-2 focus-within:ring-ring">
        <span className="sr-only">Journey name</span>
        <input
          className="w-64 bg-transparent font-heading font-semibold text-lg text-foreground outline-none"
          onChange={(event) => dispatch({ type: "rename", name: event.target.value })}
          type="text"
          value={state.name}
        />
        <PencilIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </label>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 font-semibold text-secondary-foreground text-xs">
        <PencilIcon aria-hidden className="size-2.5" />
        Draft
      </span>
      <SaveState dispatch={dispatch} state={state} />
      <div className="ms-auto flex items-center gap-2">
        <Button aria-label="Undo (Ctrl+Z)" disabled={state.past.length === 0} onClick={() => dispatch({ type: "undo" })} size="icon" title="Undo (Ctrl+Z)" variant="outline">
          <Undo2Icon aria-hidden />
        </Button>
        <Button aria-label="Redo (Ctrl+Shift+Z)" disabled={state.future.length === 0} onClick={() => dispatch({ type: "redo" })} size="icon" title="Redo (Ctrl+Shift+Z)" variant="outline">
          <Redo2Icon aria-hidden />
        </Button>
        <Button aria-label={aria} aria-pressed={checklistOpen} onClick={onChecklist} variant="outline">
          {blocking ? <CircleAlertIcon aria-hidden className="text-destructive" /> : <ClipboardListIcon aria-hidden className="text-success" />}
          Checklist
          <span
            className={cn(
              "rounded-full px-1.5 font-heading font-semibold text-[11px] tabular-nums",
              blocking ? "bg-destructive text-white" : count > 0 ? "bg-warning/12 text-warning" : "bg-secondary text-secondary-foreground",
            )}
          >
            {count}
          </span>
        </Button>
        <Button onClick={onPublish}>Publish</Button>
      </div>
    </div>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function SaveState({ state, dispatch }: { state: BuilderState; dispatch: Dispatch }) {
  const status = state.save;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" role="status">
      {status.kind === "saving" && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          Saving
        </span>
      )}
      {(status.kind === "saved" || status.kind === "conflict") && (
        <span className="inline-flex items-center gap-1 text-success">
          <CircleCheckIcon aria-hidden className="size-3" />
          Saved {TIME.format(status.kind === "saved" ? status.at : status.stored.savedAt)}
        </span>
      )}
      {status.kind === "failed" && (
        <>
          <span className="inline-flex items-center gap-1 font-semibold text-destructive">
            <CircleAlertIcon aria-hidden className="size-3" />
            Not saved.
          </span>
          <button className="font-semibold text-destructive underline" onClick={() => dispatch({ type: "retry" })} type="button">
            Retry
          </button>
        </>
      )}
    </span>
  );
}

function Banner({ state, dispatch }: { state: BuilderState; dispatch: Dispatch }) {
  if (state.save.kind === "conflict") {
    return (
      <div className="flex flex-wrap items-center gap-2.5 border-warning/25 border-b bg-warning/8 px-6 py-2 text-sm" role="alert">
        <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
        <b className="text-warning">This draft changed somewhere else.</b>
        <span className="text-muted-foreground">Another tab or computer saved it after you opened it. Your last edit is not saved.</span>
        <span className="ms-auto flex gap-2">
          <Button onClick={() => dispatch({ type: "loadLatest" })} size="sm" variant="outline">
            Load latest
          </Button>
          <Button onClick={() => dispatch({ type: "keepMine" })} size="sm" variant="outline">
            Keep mine
          </Button>
        </span>
      </div>
    );
  }
  if (state.save.kind === "stale") {
    const copy = () => void navigator.clipboard?.writeText(JSON.stringify({ name: state.name, root: rootOfGraph(state.graph) }, null, 2));
    return (
      <div className="flex flex-wrap items-center gap-2.5 border-info/25 border-b bg-info/8 px-6 py-2 text-sm" role="alert">
        <RefreshCwIcon aria-hidden className="size-3.5 text-info" />
        <b className="text-info">Studio was updated. Reload to keep editing.</b>
        <span className="text-muted-foreground">Saved edits survive the reload. Copy your last unsaved change first if you need it.</span>
        <span className="ms-auto flex gap-2">
          <Button onClick={copy} size="sm" variant="outline">
            Copy unsaved changes
          </Button>
          <Button onClick={() => window.location.reload()} size="sm">
            Reload
          </Button>
        </span>
      </div>
    );
  }
  return null;
}

const DRAG_TYPE = "application/x-journey-step";

function Palette({ onAdd, target, onClearTarget }: { onAdd: (entry: PaletteEntry, at: InsertAt | null) => void; target: InsertAt | null; onClearTarget: () => void }) {
  const [search, setSearch] = useState("");
  const entries = paletteEntries(RUNTIME_REGISTRY, search);
  return (
    <aside aria-label="Steps you can add" className="w-[212px] shrink-0 overflow-y-auto border-border border-e bg-card px-3 py-3.5">
      <label className="flex items-center gap-2 rounded-control border border-input bg-background px-2.5 py-1.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
        <SearchIcon aria-hidden className="size-3.5" />
        <span className="sr-only">Search steps</span>
        <input
          className="w-full min-w-0 bg-transparent text-foreground text-xs outline-none"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search steps"
          type="search"
          value={search}
        />
      </label>
      {target ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Pick a step to add at the chosen +.{" "}
          <button className="font-semibold text-primary" onClick={onClearTarget} type="button">
            Cancel
          </button>
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground text-xs">
          Click to add at the end, or drag onto a <b>+</b> between steps.
        </p>
      )}
      {PALETTE_GROUPS.map((group) => {
        const inGroup = entries.filter((entry) => entry.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group}>
            <div className="mt-3.5 mb-1.5 font-semibold text-[10.5px] text-muted-foreground tracking-wider">{group}</div>
            <div className={cn("gap-1.5", group === "MESSAGES" ? "grid grid-cols-2" : "flex flex-col")}>
              {inGroup.map((entry) => {
                const disabled = entry.key === "end" || (target !== null && entry.key === "branch-by-event");
                return (
                  <button
                    className="flex w-full items-center gap-2 rounded-control border border-border bg-background px-2 py-1.5 text-left text-xs hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    draggable={!disabled && entry.item !== null}
                    key={entry.key}
                    onClick={() => onAdd(entry, target)}
                    onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, entry.key)}
                    title={entry.key === "end" ? "Every path already ends with an End step." : undefined}
                    type="button"
                  >
                    <StepIcon kind={entry.key} />
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function branchTag(parent: CampaignNode | undefined, type: string): string | null {
  if (!parent) return null;
  const label = getBranchOptions(parent).find((option) => option.value === type)?.label ?? null;
  if (label === "Success") return "On success";
  if (label === "Timeout") return "On timeout";
  return label === "Next" ? null : label;
}

interface CanvasProps {
  state: BuilderState;
  eventName: EventName;
  problems: ReturnType<typeof validateJourney>["problems"];
  target: InsertAt | null;
  onSelect: (id: string | null) => void;
  onAddAt: (at: InsertAt) => void;
  onDrop: (entry: PaletteEntry, at: InsertAt) => void;
  onRemove: (node: CampaignNode) => void;
}

function Canvas({ state, eventName, problems, target, onSelect, onAddAt, onDrop, onRemove }: CanvasProps) {
  const layout = useMemo(() => layoutGraph(state.graph), [state.graph]);
  const byId = useMemo(() => new Map(state.graph.nodes.map((n) => [n.id, n])), [state.graph.nodes]);

  // Arrow keys move along the tree, Enter opens the panel, Delete removes the step.
  const onKey = (node: CampaignNode) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const parent = state.graph.connections.find((c) => c.to === node.id)?.from;
    const siblings = state.graph.connections.filter((c) => c.from === parent).map((c) => c.to);
    const index = siblings.indexOf(node.id);
    const move: Record<string, string | undefined> = {
      ArrowUp: parent,
      ArrowDown: state.graph.connections.find((c) => c.from === node.id)?.to,
      ArrowLeft: siblings[index - 1],
      ArrowRight: siblings[index + 1],
    };
    if (event.key in move) {
      event.preventDefault();
      const next = move[event.key];
      if (next) document.getElementById(`step-${next}`)?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      onRemove(node);
    }
  };

  const entryOf = (key: string) => paletteEntries(RUNTIME_REGISTRY, "").find((entry) => entry.key === key);

  return (
    <section aria-label="Journey canvas" className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-2.5 border-border border-b px-4 py-2 text-muted-foreground text-xs">
        <span>Steps are laid out for you, top to bottom.</span>
        <span className="ms-auto">Arrow keys move between steps · Enter opens · Delete removes</span>
      </div>
      <div className="flex-1 overflow-auto bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_10%,transparent)_1px,transparent_1px)] bg-size-[18px_18px]">
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
          <svg aria-hidden className="absolute inset-0 text-muted-foreground/60" height={layout.height} width={layout.width}>
            <g fill="none" stroke="currentColor" strokeWidth={2}>
              {layout.edges.map((edge) => (
                <path d={edge.d} key={`${edge.from}-${edge.to}`} />
              ))}
            </g>
          </svg>
          {layout.edges.map((edge) => {
            const tag = edge.tag && branchTag(byId.get(edge.from), edge.type);
            const from = byId.get(edge.from);
            const fromLabel = from ? cardText(from, eventName).label : "the step";
            const at = { from: edge.from, to: edge.to };
            const chosen = target?.from === edge.from && target.to === edge.to;
            return (
              <div key={`plus-${edge.from}-${edge.to}`}>
                {tag && edge.tag && (
                  <span
                    className="-translate-x-1/2 -translate-y-1/2 absolute rounded-full bg-secondary px-2 font-semibold text-[11px] text-secondary-foreground"
                    style={{ left: edge.tag.x, top: edge.tag.y }}
                  >
                    {tag}
                  </span>
                )}
                <button
                  aria-label={tag ? `Add a step ${tag.toLowerCase()}` : `Add a step after ${fromLabel}`}
                  aria-pressed={chosen}
                  className={cn(
                    "-ms-[11px] -mt-[11px] absolute flex size-[22px] items-center justify-center rounded-full border bg-card text-muted-foreground hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring",
                    chosen ? "border-primary text-primary" : "border-border",
                  )}
                  onClick={() => onAddAt(at)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const entry = entryOf(event.dataTransfer.getData(DRAG_TYPE));
                    if (entry) onDrop(entry, at);
                  }}
                  style={{ left: edge.plus.x, top: edge.plus.y }}
                  type="button"
                >
                  <PlusIcon aria-hidden className="size-3" />
                </button>
              </div>
            );
          })}
          {state.graph.nodes.map((node) => {
            const place = layout.nodes.get(node.id);
            if (!place) return null;
            const text = cardText(node, eventName);
            const mine = problems.filter((problem) => problem.nodeId === node.id);
            const blocks = mine.filter((problem) => problem.severity === "blocking").length;
            const warns = mine.length - blocks;
            const selected = node.id === state.selected;
            return (
              <button
                aria-label={`${text.label}${blocks ? ", has a problem that blocks publishing" : ""}${warns ? ", has a warning" : ""}`}
                aria-pressed={selected}
                className={cn(
                  "absolute flex flex-col rounded-card border bg-card px-3 py-2 text-left text-foreground hover:border-primary/45 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                  selected ? "border-primary shadow-md shadow-primary/20" : "border-border",
                )}
                id={`step-${node.id}`}
                key={node.id}
                onClick={() => onSelect(node.id)}
                onKeyDown={onKey(node)}
                style={{ left: place.x, top: place.y, width: CARD.width, height: node.type === "end" ? CARD.endHeight : CARD.height }}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <StepIcon node={node} />
                  <span className="font-semibold text-[10.5px] text-muted-foreground tracking-wider">{text.kind}</span>
                  <span className="ms-auto flex gap-1">
                    {blocks > 0 && (
                      <span className="inline-flex items-center gap-0.5 font-heading font-semibold text-destructive text-xs tabular-nums" title="Blocks publishing">
                        <CircleAlertIcon aria-hidden className="size-3" />
                        {blocks}
                      </span>
                    )}
                    {warns > 0 && (
                      <span className="inline-flex items-center gap-0.5 font-heading font-semibold text-warning text-xs tabular-nums" title="Warning">
                        <TriangleAlertIcon aria-hidden className="size-3" />
                        {warns}
                      </span>
                    )}
                  </span>
                </span>
                <span className="mt-1 truncate font-semibold text-[13px]">{text.label}</span>
                {text.sub && <span className="truncate text-muted-foreground text-xs">{text.sub}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
