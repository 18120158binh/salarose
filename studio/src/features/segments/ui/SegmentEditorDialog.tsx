"use client";

import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { METRIC_DEFINITION_FUNCTIONS } from "shared/lib/metricDefinitions";
import {
  BEHAVIOR_OPERATORS,
  PROPERTY_OPERATORS,
  SEGMENT_PROFILE_FIELDS,
  WINDOW_UNITS,
  measureReadsAttribute,
  type SegmentUse,
} from "shared/lib/segments";
import type { UserEventDef } from "shared/types";
import {
  newBehaviorCondition,
  newProfileCondition,
  type ConditionDraft,
  type SegmentDraft,
} from "../model/segmentDraft";
import { EventFilters } from "./EventFilters";

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "w-36",
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-label={label} size="sm" className={className}>
        <SelectValue>{options.find((option) => option.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

function ConditionRow({
  condition,
  events,
  onChange,
  onRemove,
}: {
  condition: ConditionDraft;
  events: UserEventDef[];
  onChange: (condition: ConditionDraft) => void;
  onRemove: () => void;
}) {
  const remove = (
    <Button variant="ghost" size="icon-sm" aria-label="Remove condition" onClick={onRemove}>
      <Trash2 />
    </Button>
  );
  if (condition.type === "profile_property") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Profile</span>
        <Choice label="Profile field" value={condition.field} options={plain(SEGMENT_PROFILE_FIELDS)}
          onChange={(field) => onChange({ ...condition, field })} />
        <Choice label="Operator" value={condition.op} options={plain(PROPERTY_OPERATORS)} className="w-24"
          onChange={(op) => onChange({ ...condition, op })} />
        <Input aria-label="Value" size="sm" className="w-56" value={condition.value}
          placeholder={condition.op === "IN" ? "Hanoi, Da Nang" : "Value"}
          onChange={(event) => onChange({ ...condition, value: event.target.value })} />
        {remove}
      </div>
    );
  }
  const event = events.find((item) => item.name === condition.event);
  const eventOptions = events.map((item) => ({ value: item.name, label: item.label || item.name }));
  if (condition.event && !event) eventOptions.push({ value: condition.event, label: condition.event });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Did</span>
      <Choice label="Event" value={condition.event} options={eventOptions} className="w-44"
        onChange={(name) => onChange({ ...condition, event: name, attribute: "", filters: [], keptFilters: undefined })} />
      <Choice label="Measure" value={condition.measure} options={plain(METRIC_DEFINITION_FUNCTIONS)}
        onChange={(measure) => onChange({ ...condition, measure, attribute: measureReadsAttribute(measure) ? condition.attribute : "" })} />
      {measureReadsAttribute(condition.measure) && (
        <Choice label="Attribute" value={condition.attribute} className="w-40"
          options={(event?.fields ?? []).map((field) => ({ value: field.value, label: field.label || field.value }))}
          onChange={(attribute) => onChange({ ...condition, attribute })} />
      )}
      <Choice label="Comparison" value={condition.op} options={plain(BEHAVIOR_OPERATORS)} className="w-20"
        onChange={(op) => onChange({ ...condition, op })} />
      <Input aria-label="Threshold" size="sm" inputMode="decimal" className="w-20" value={condition.value}
        onChange={(change) => onChange({ ...condition, value: change.target.value })} />
      <span className="text-sm text-muted-foreground">in the last</span>
      <Input aria-label="Window" size="sm" inputMode="numeric" className="w-16" value={condition.windowValue}
        onChange={(change) => onChange({ ...condition, windowValue: change.target.value })} />
      <Choice label="Window unit" value={condition.windowUnit} options={plain(WINDOW_UNITS)} className="w-28"
        onChange={(windowUnit) => onChange({ ...condition, windowUnit })} />
      {remove}
      {condition.keptFilters ? (
        <span className="w-full text-xs text-muted-foreground">Keeps its saved event filters.</span>
      ) : (
        <EventFilters event={event} filters={condition.filters} mark={null}
          onChange={(filters) => onChange({ ...condition, filters })} />
      )}
    </div>
  );
}

export interface SegmentEditorDialogProps {
  open: boolean;
  draft: SegmentDraft;
  /** The campaigns that use the segment, named before a save (SEG-FR-07). */
  usedBy: SegmentUse[];
  events: UserEventDef[];
  error: string | null;
  saving: boolean;
  onDraftChange: (draft: SegmentDraft) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}

export function SegmentEditorDialog({
  open,
  draft,
  usedBy,
  events,
  error,
  saving,
  onDraftChange,
  onSave,
  onOpenChange,
}: SegmentEditorDialogProps) {
  const firstEvent = events[0]?.name ?? "";
  const setGroups = (groups: ConditionDraft[][]) => onDraftChange({ ...draft, groups });
  const setCondition = (groupIndex: number, index: number, condition: ConditionDraft) =>
    setGroups(draft.groups.map((group, g) => (g === groupIndex ? group.map((item, i) => (i === index ? condition : item)) : group)));
  const removeCondition = (groupIndex: number, index: number) =>
    setGroups(draft.groups
      .map((group, g) => (g === groupIndex ? group.filter((_, i) => i !== index) : group))
      .filter((group) => group.length > 0));
  const addCondition = (groupIndex: number, condition: ConditionDraft) =>
    setGroups(draft.groups.map((group, g) => (g === groupIndex ? [...group, condition] : group)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{draft.create ? "New segment" : `Edit ${draft.name || "segment"}`}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          {!draft.create && usedBy.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                A change applies to the next evaluation in every campaign that uses this segment:{" "}
                {usedBy.map((use) => `${use.campaignName} (${use.status})`).join(", ")}.
              </AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
          </Field>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              A person is in the segment when every group passes. A group passes when any of its conditions does.
            </p>
            {draft.groups.map((group, groupIndex) => (
              <section key={groupIndex} aria-label={`Group ${groupIndex + 1}`}
                className="flex flex-col gap-3 rounded-xl border border-border p-4">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Group {groupIndex + 1}
                </span>
                {group.map((condition, index) => (
                  <ConditionRow key={index} condition={condition} events={events}
                    onChange={(next) => setCondition(groupIndex, index, next)}
                    onRemove={() => removeCondition(groupIndex, index)} />
                ))}
                <div className="flex gap-2">
                  <Button variant="outline" size="xs" onClick={() => addCondition(groupIndex, newProfileCondition())}>
                    <Plus /> Profile condition
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => addCondition(groupIndex, newBehaviorCondition(firstEvent))}>
                    <Plus /> Behavior condition
                  </Button>
                </div>
              </section>
            ))}
            <Button variant="outline" size="sm" className="self-start"
              onClick={() => setGroups([...draft.groups, [newProfileCondition()]])}>
              <Plus /> Group
            </Button>
          </div>
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSave} disabled={saving}>Save segment</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
