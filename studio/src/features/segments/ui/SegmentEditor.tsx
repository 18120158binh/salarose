"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition, type ReactNode } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { notify } from "@/shared/ui/v2/toast";
import type { MetricAggregationFunction } from "shared/lib/metricDefinitions";
import {
  BEHAVIOR_OPERATORS,
  PROPERTY_OPERATORS,
  SEGMENT_PROFILE_FIELDS,
  WINDOW_UNITS,
  measureReadsAttribute,
  type BehaviorOperator,
  type PropertyOperator,
  type SegmentProfileField,
  type SegmentUse,
  type WindowUnit,
} from "shared/lib/segments";
import type { UserEventDef } from "shared/types";
import { saveSegmentV2Action } from "../model/actions";
import {
  firstProblem,
  measureLabel,
  newBehaviorCondition,
  newProfileCondition,
  OFFERED_MEASURES,
  segmentInput,
  type BehaviorConditionDraft,
  type ConditionDraft,
  type DraftField,
  type DraftProblem,
  type ProfileConditionDraft,
  type SegmentDraft,
} from "../model/segmentDraft";
import type { JourneyUse, SegmentDetails } from "../model/segmentList";
import { WhereUsed } from "./SegmentList";

const PROFILE_LABELS = { gender: "Gender", age: "Age", city: "City", user_time: "User time" } as const satisfies Record<SegmentProfileField, string>;

const PROPERTY_OP_LABELS = {
  IN: "is any of",
  "=": "is",
  "!=": "is not",
  LIKE: "contains",
  ">": "is more than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
} as const satisfies Record<PropertyOperator, string>;

const BEHAVIOR_OP_LABELS = {
  ">=": "at least",
  ">": "more than",
  "=": "exactly",
  "!=": "not",
  "<=": "at most",
  "<": "fewer than",
} as const satisfies Record<BehaviorOperator, string>;

const UNIT_LABELS = {
  SECONDS: "seconds",
  MINUTES: "minutes",
  HOURS: "hours",
  DAYS: "days",
  WEEKS: "weeks",
  MONTHS: "months",
} as const satisfies Record<WindowUnit, string>;

export interface SegmentEditorProps {
  initial: SegmentDraft;
  usedBy: readonly JourneyUse[];
  events: readonly UserEventDef[];
  /** Null for a new segment. */
  details: SegmentDetails | null;
}

type Mark = { group: number; condition: number; field: DraftField } | null;

function markOf(problem: DraftProblem | null): Mark {
  return problem && problem.group !== null && problem.condition !== null
    ? { group: problem.group, condition: problem.condition, field: problem.field }
    : null;
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  invalid = false,
  className = "w-40",
  footer,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; system?: string }[];
  onChange: (value: T) => void;
  invalid?: boolean;
  className?: string;
  footer?: ReactNode;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Select onValueChange={(next) => onChange(next as T)} value={value}>
      <SelectTrigger aria-invalid={invalid || undefined} aria-label={label} className={className} size="sm">
        <SelectValue>{current?.label ?? (value || "Pick one")}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex w-full items-center justify-between gap-3">
              {option.label}
              {option.system && <span className="font-mono text-ink-muted text-xs">{option.system}</span>}
            </span>
          </SelectItem>
        ))}
        {footer}
      </SelectPopup>
    </Select>
  );
}

function entries<K extends string>(labels: Record<K, string>, order: readonly K[]) {
  return order.map((value) => ({ value, label: labels[value] }));
}

function ProfileRow({
  condition,
  mark,
  onChange,
}: {
  condition: ProfileConditionDraft;
  mark: DraftField | null;
  onChange: (next: ConditionDraft) => void;
}) {
  return (
    <>
      <span className="rounded-control bg-muted px-2 py-0.5 font-medium text-xs">Profile</span>
      <Choice
        footer={
          // Lead default 17 (SEG-FR-40): imported fields stay out of reach, with the reason, until
          // the segment runtime evaluates them.
          <SelectGroup>
            <SelectGroupLabel>Imported</SelectGroupLabel>
            <p className="px-2 pb-2 text-ink-muted text-xs">Imported fields show here once journeys can check them.</p>
          </SelectGroup>
        }
        label="Profile field"
        onChange={(field) => onChange({ ...condition, field })}
        options={SEGMENT_PROFILE_FIELDS.map((field) => ({ value: field, label: PROFILE_LABELS[field], system: field }))}
        value={condition.field}
      />
      <Choice
        className="w-36"
        label="Operator"
        onChange={(op) => onChange({ ...condition, op })}
        options={entries(PROPERTY_OP_LABELS, PROPERTY_OPERATORS)}
        value={condition.op}
      />
      <Input
        aria-invalid={mark === "value" || undefined}
        aria-label="Value"
        className="w-56"
        onChange={(event) => onChange({ ...condition, value: event.target.value })}
        placeholder={condition.op === "IN" ? "Hà Nội, Đà Nẵng" : "Value"}
        size="sm"
        value={condition.value}
      />
    </>
  );
}

function BehaviorRow({
  condition,
  events,
  mark,
  onChange,
}: {
  condition: BehaviorConditionDraft;
  events: readonly UserEventDef[];
  mark: DraftField | null;
  onChange: (next: ConditionDraft) => void;
}) {
  const event = events.find((item) => item.name === condition.event);
  const eventOptions = events.map((item) => ({ value: item.name, label: item.label || item.name }));
  if (condition.event && !event) eventOptions.push({ value: condition.event, label: condition.event });
  const measures: MetricAggregationFunction[] = [...OFFERED_MEASURES];
  if (!measures.includes(condition.measure)) measures.push(condition.measure);
  const fields = (event?.fields ?? []).map((field) => ({ value: field.value, label: field.label || field.value, system: field.value }));
  const eventName = event?.label || condition.event || "an event";
  return (
    <>
      <span className="rounded-control bg-muted px-2 py-0.5 font-medium text-xs">Behavior</span>
      <span className="text-muted-foreground text-sm">performed</span>
      <Choice
        className="w-44"
        invalid={mark === "event"}
        label="Event"
        onChange={(name) => onChange({ ...condition, event: name, attribute: "" })}
        options={eventOptions}
        value={condition.event}
      />
      <Choice
        className="w-48"
        label="Measure"
        onChange={(measure) =>
          onChange({ ...condition, measure, attribute: measureReadsAttribute(measure) ? condition.attribute : "" })
        }
        options={measures.map((measure) => ({ value: measure, label: measureLabel(measure), system: measure }))}
        value={condition.measure}
      />
      {measureReadsAttribute(condition.measure) && (
        <Choice
          className="w-40"
          invalid={mark === "attribute"}
          label="Field to measure"
          onChange={(attribute) => onChange({ ...condition, attribute })}
          options={fields}
          value={condition.attribute}
        />
      )}
      <Choice
        className="w-28"
        label="Comparison"
        onChange={(op) => onChange({ ...condition, op })}
        options={entries(BEHAVIOR_OP_LABELS, BEHAVIOR_OPERATORS)}
        value={condition.op}
      />
      <Input
        aria-invalid={mark === "threshold" || undefined}
        aria-label="Threshold"
        className="w-20 font-heading tabular-nums"
        inputMode="decimal"
        onChange={(change) => onChange({ ...condition, value: change.target.value })}
        size="sm"
        value={condition.value}
      />
      <span className="text-muted-foreground text-sm">in the last</span>
      <Input
        aria-invalid={mark === "window" || undefined}
        aria-label="Window"
        className="w-16 font-heading tabular-nums"
        inputMode="numeric"
        onChange={(change) => onChange({ ...condition, windowValue: change.target.value })}
        size="sm"
        value={condition.windowValue}
      />
      <Choice
        className="w-28"
        label="Window unit"
        onChange={(windowUnit) => onChange({ ...condition, windowUnit })}
        options={entries(UNIT_LABELS, WINDOW_UNITS)}
        value={condition.windowUnit}
      />
      <p className="w-full text-muted-foreground text-xs">
        Reads as: performed <span className="font-medium text-foreground">{eventName}</span>{" "}
        {condition.measure === "COUNT" ? (
          <>
            <span className="font-medium text-foreground">
              {BEHAVIOR_OP_LABELS[condition.op]} {condition.value || "_"}
            </span>{" "}
            times
          </>
        ) : (
          <>
            with {measureLabel(condition.measure).toLowerCase()}{" "}
            <span className="font-mono">{condition.attribute || "_"}</span>{" "}
            <span className="font-medium text-foreground">
              {BEHAVIOR_OP_LABELS[condition.op]} {condition.value || "_"}
            </span>
          </>
        )}{" "}
        in the last{" "}
        <span className="font-medium text-foreground">
          {condition.windowValue || "_"} {UNIT_LABELS[condition.windowUnit]}
        </span>
        .
      </p>
      {condition.filters && (
        <p className="w-full text-muted-foreground text-xs">Keeps its saved event filters. Segments can&apos;t change them yet.</p>
      )}
    </>
  );
}

function journeyList(uses: readonly { campaignName: string; status: string }[]): string {
  const named = uses.map((use) => `${use.campaignName} (${use.status === "active" ? "Active" : "Paused"})`);
  return named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

const SIZE_LIMITS = [
  "A shopper stays counted until their next event, even after their behavior window passes with no new event.",
  "An imported customer who starts shopping on the site can count twice until the next nightly pass.",
  "After an outage of more than a day, a shopper whose change was lost counts again only at a later event.",
  "A new behavior condition counts from the day it was saved, so a 7-day window needs 7 days of history.",
];

// SEG-FR-01, SEG-FR-03, SEG-FR-07, SEG-FR-08, SEG-FR-11, SEG-FR-43: the full-page segment editor.
export function SegmentEditor({ initial, usedBy, events, details }: SegmentEditorProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SegmentUse[] | null>(null);
  const [saving, startSaving] = useTransition();
  const mark = markOf(problem);
  const firstEvent = events[0]?.name ?? "";
  const title = initial.create ? "New segment" : initial.name;
  const activeUse = usedBy.some((use) => use.status === "active");

  const setGroups = (groups: ConditionDraft[][]) => setDraft({ ...draft, groups });
  const setCondition = (g: number, c: number, next: ConditionDraft) =>
    setGroups(draft.groups.map((group, gi) => (gi === g ? group.map((item, ci) => (ci === c ? next : item)) : group)));
  const removeCondition = (g: number, c: number) =>
    setGroups(draft.groups.map((group, gi) => (gi === g ? group.filter((_, ci) => ci !== c) : group)).filter((group) => group.length > 0));
  const addCondition = (g: number, next: ConditionDraft) =>
    setGroups(draft.groups.map((group, gi) => (gi === g ? [...group, next] : group)));

  const submit = (confirmed: readonly string[]) => {
    const found = firstProblem(draft);
    setProblem(found);
    setServerError(null);
    if (found) return;
    startSaving(async () => {
      const result = await saveSegmentV2Action(segmentInput(draft), confirmed);
      if ("confirm" in result) {
        setConfirm(result.confirm);
        return;
      }
      setConfirm(null);
      if ("error" in result) {
        setServerError(`${result.error} Nothing you typed was lost.`);
        return;
      }
      notify({ kind: "done", title: "Segment saved. Journeys use it from each shopper's next event." });
      if (draft.create) router.push(`/v2/segments/${encodeURIComponent(result.id)}`);
      else router.refresh();
    });
  };

  const message = problem?.message ?? serverError;

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button render={<Link href="/v2/segments" />} variant="ghost">
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => submit([])}>
              Save segment
            </Button>
          </>
        }
        preview
        title={title}
      />
      {usedBy.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            A change applies to the next evaluation in every journey that uses this segment: {journeyList(usedBy)}.
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert variant="error">
          <AlertTitle>Not saved.</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-space-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-space-4">
          <SectionCard title="Name and description">
            <div className="flex flex-col gap-space-3">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  aria-invalid={problem?.field === "name" || undefined}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  value={draft.name}
                />
              </Field>
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Textarea
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="Shoppers in Hà Nội who added to cart at least 2 times in the last 7 days."
                  value={draft.description}
                />
              </Field>
            </div>
          </SectionCard>
          <SectionCard
            description="All of these groups must hold · Checked at each shopper's events"
            title="Who is in this segment"
          >
            <p className="mb-space-3 text-muted-foreground text-sm">
              A shopper is in the segment when every group holds. A group holds when any one of its conditions does.
            </p>
            <div className="flex flex-col gap-space-2">
              {draft.groups.map((group, g) => (
                <Fragment key={g}>
                  {g > 0 && (
                    <span className="self-start rounded-control bg-muted px-2 py-0.5 font-heading font-semibold text-xs">AND</span>
                  )}
                  <section aria-label={`Group ${g + 1}`} className="flex flex-col gap-space-3 rounded-card border border-border p-space-3">
                    <span className="font-heading font-semibold text-muted-foreground text-xs tracking-wide">
                      GROUP {g + 1} <span className="font-normal">· Any of these</span>
                    </span>
                    {group.map((condition, c) => {
                      const rowMark = mark && mark.group === g && mark.condition === c ? mark.field : null;
                      return (
                        <div className="flex flex-wrap items-center gap-2" key={c}>
                          {condition.type === "profile_property" ? (
                            <ProfileRow condition={condition} mark={rowMark} onChange={(next) => setCondition(g, c, next)} />
                          ) : (
                            <BehaviorRow
                              condition={condition}
                              events={events}
                              mark={rowMark}
                              onChange={(next) => setCondition(g, c, next)}
                            />
                          )}
                          <Button
                            aria-label={`Remove group ${g + 1}, condition ${c + 1}`}
                            className="ml-auto"
                            onClick={() => removeCondition(g, c)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => addCondition(g, newProfileCondition())} size="xs" variant="outline">
                        <PlusIcon aria-hidden /> Or profile condition
                      </Button>
                      <Button onClick={() => addCondition(g, newBehaviorCondition(firstEvent))} size="xs" variant="outline">
                        <PlusIcon aria-hidden /> Or behavior condition
                      </Button>
                    </div>
                  </section>
                </Fragment>
              ))}
              <Button className="self-start" onClick={() => setGroups([...draft.groups, [newProfileCondition()]])} size="sm" variant="outline">
                <PlusIcon aria-hidden /> And another group
              </Button>
              <p className="text-muted-foreground text-xs">
                A segment can&apos;t check another segment. Filters on an event&apos;s fields, like price over 500,000 ₫,
                come later for segments; a condition saved with filters keeps them.
              </p>
            </div>
          </SectionCard>
        </div>
        <aside className="flex flex-col gap-space-4">
          <SectionCard title="Used by">
            <WhereUsed uses={usedBy} />
            {activeUse && (
              <p className="mt-2 text-muted-foreground text-xs">
                Saving asks you to confirm first, because an active journey uses this segment.
              </p>
            )}
          </SectionCard>
          <SectionCard title="Size">
            <p className="text-sm">Size shows once membership is stored.</p>
            <h3 className="mt-3 font-medium text-xs">What this count can&apos;t tell you</h3>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-muted-foreground text-xs">
              {SIZE_LIMITS.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground text-xs">
              Journeys never use this count. They check each shopper at the moment they act.
            </p>
          </SectionCard>
          <SectionCard title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              {details && (
                <>
                  <dt className="text-muted-foreground">Created by</dt>
                  <dd>{details.createdBy}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd title={details.created?.exact}>{details.created?.text ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Last change</dt>
                  <dd title={details.lastChange?.exact}>{details.lastChange?.text ?? "Unknown"}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Segment id</dt>
              <dd className="break-all font-mono text-xs">{draft.id}</dd>
            </dl>
          </SectionCard>
        </aside>
      </div>
      <AlertDialog onOpenChange={(open) => !open && setConfirm(null)} open={confirm !== null}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Change a segment that an active journey uses?</AlertDialogTitle>
            <AlertDialogDescription>
              From each shopper&apos;s next event, this journey uses the new conditions. Shoppers who now match can start
              it, and shoppers who no longer match stop counting as members.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 pb-2">
            <WhereUsed uses={(confirm ?? []).map((use) => ({ campaignId: use.campaignId, campaignName: use.campaignName, status: use.status, kinds: use.kinds, href: null }))} />
            <p className="mt-2 text-muted-foreground text-xs">Nothing is saved until you confirm.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button disabled={saving} onClick={() => submit((confirm ?? []).map((use) => use.campaignId))}>
              Save change
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
