"use client";

import { useEffect, useId, useRef } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PROPERTY_OPERATORS, type PropertyOperator } from "shared/lib/segments";
import type { UserEventDef, UserEventFieldDef } from "shared/types";
import { newFilter, type DraftField, type FilterDraft } from "../model/segmentDraft";

const OP_LABELS = {
  "=": "is",
  "!=": "is not",
  ">": "is greater than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
  LIKE: "contains",
  IN: "is one of",
} as const satisfies Record<PropertyOperator, string>;

const NUMBER_OPS: readonly PropertyOperator[] = ["=", "!=", ">", ">=", "<", "<=", "IN"];
const TEXT_OPS: readonly PropertyOperator[] = ["=", "!=", "LIKE", "IN"];

type EventField = UserEventFieldDef;

function isNumberField(field: EventField | undefined): boolean {
  const type = String(field?.dataType ?? "").toLowerCase();
  return ["number", "numeric", "integer", "int", "long", "float", "double", "decimal"].includes(type);
}

function operatorsFor(field: EventField | undefined): readonly PropertyOperator[] {
  if (!field) return PROPERTY_OPERATORS;
  return isNumberField(field) ? NUMBER_OPS : TEXT_OPS;
}

export interface EventFiltersProps {
  filters: FilterDraft[];
  event: UserEventDef | undefined;
  /** The field the last refused save marked, with the filter it is in. */
  mark: { field: DraftField; filter?: number } | null;
  onChange: (filters: FilterDraft[]) => void;
}

// SEG-FR-11: the WHERE rows under a behavior condition. Every filter must pass for an event to count.
// "+ filter" moves focus to the new filter's field; removing a filter returns focus to "+ filter".
export function EventFilters({ filters, event, mark, onChange }: EventFiltersProps) {
  const idBase = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const fieldRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Where focus goes after the next render, which adds or removes the filter row.
  const focusTarget = useRef<number | "add" | null>(null);
  const fields = (event?.fields ?? []).filter((field) => String(field.dataType ?? "").toLowerCase() !== "json");

  useEffect(() => {
    const target = focusTarget.current;
    if (target === null) return;
    focusTarget.current = null;
    (target === "add" ? addRef.current : fieldRefs.current[target])?.focus();
  });

  const setFilter = (index: number, next: FilterDraft) => onChange(filters.map((item, i) => (i === index ? next : item)));
  const remove = (index: number) => {
    onChange(filters.filter((_, i) => i !== index));
    focusTarget.current = "add";
  };
  const add = () => {
    onChange([...filters, newFilter()]);
    focusTarget.current = filters.length;
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {filters.length > 0 && (
        <div
          aria-label={`Event filters for ${event?.name ?? "this event"}`}
          className="grid gap-2 rounded-r-card border-primary/40 border-l-2 bg-primary/5 px-3 py-2.5"
          role="group"
        >
      {filters.map((filter, index) => {
        const field = fields.find((item) => item.value === filter.field);
        const operators = operatorsFor(field);
        const marked = mark?.filter === index ? mark.field : null;
        const errorId = `${idBase}-filter-${index}-error`;
        const described = marked ? errorId : undefined;
        const noField = !filter.field;
        const fieldOptions = fields.map((item) => ({ value: item.value, label: item.label || item.value }));
        if (filter.field && !field) fieldOptions.push({ value: filter.field, label: filter.field });
        return (
          <div className="flex flex-wrap items-center gap-2" key={index}>
            <span className="w-12 font-heading font-semibold text-muted-foreground text-xs">{index === 0 ? "WHERE" : "AND"}</span>
            <Select
              onValueChange={(next) => {
                const nextField = fields.find((item) => item.value === next);
                const op = operatorsFor(nextField).includes(filter.op) ? filter.op : "=";
                setFilter(index, { ...filter, field: String(next), op });
              }}
              value={filter.field}
            >
              <SelectTrigger
                aria-describedby={marked === "filter-field" ? described : undefined}
                aria-invalid={marked === "filter-field" || undefined}
                aria-label={`Filter ${index + 1} field`}
                className="w-44"
                ref={(node: HTMLButtonElement | null) => {
                  fieldRefs.current[index] = node;
                }}
                size="sm"
              >
                <SelectValue>{fieldOptions.find((item) => item.value === filter.field)?.label ?? "Choose a field"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {fieldOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    <span className="flex w-full items-center justify-between gap-3">
                      {item.label}
                      <span className="font-mono text-ink-muted text-xs">{item.value}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.field && <span className="font-mono text-ink-muted text-xs">{filter.field}</span>}
            <Select disabled={noField} onValueChange={(next) => setFilter(index, { ...filter, op: next as PropertyOperator })} value={filter.op}>
              <SelectTrigger aria-label={`Filter ${index + 1} operator`} className="w-36" size="sm">
                <SelectValue>{OP_LABELS[filter.op]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {operators.map((op) => (
                  <SelectItem key={op} value={op}>{OP_LABELS[op]}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              aria-describedby={marked === "filter-value" ? described : undefined}
              aria-invalid={marked === "filter-value" || undefined}
              aria-label={`Filter ${index + 1} value`}
              className="w-40"
              disabled={noField}
              inputMode={isNumberField(field) && filter.op !== "IN" ? "decimal" : undefined}
              onChange={(change) => setFilter(index, { ...filter, value: change.target.value })}
              placeholder={filter.op === "IN" ? "Shoes, Bags" : "Value"}
              size="sm"
              value={filter.value}
            />
            <Button aria-label={noField ? "Remove filter" : `Remove filter ${fieldOptions.find((item) => item.value === filter.field)?.label ?? filter.field}`} onClick={() => remove(index)} size="icon-sm" variant="ghost">
              <XIcon />
            </Button>
            {marked && (
              <span className="w-full pl-14 text-destructive text-xs" id={errorId}>
                {marked === "filter-value" ? "Needs a value" : "Needs a field"}
              </span>
            )}
          </div>
        );
      })}
        </div>
      )}
      <Button className="self-start" onClick={add} ref={addRef} size="xs" variant="ghost">
        <PlusIcon aria-hidden /> filter
      </Button>
    </div>
  );
}
