import React from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGGREGATION_OPERATOR_LABELS, AGGREGATION_TEMPLATES, TIME_UNIT_LABELS } from "@/entities/journey/model/conditionConfig";
import { normalizeMetricFunction } from "shared/lib/metricDefinitions";
import type { BehaviorCondition, BehaviorOperator, WindowUnit } from "shared/types/campaigns";
import { type EventOption, catalogFields } from "./editorTypes";

const DEFAULT_WINDOW = { value: 7, unit: "DAYS" as const };

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

// The builder offers only the functions it has a template for, and shows any other as COUNT.
function templateFunction(value?: string | null): string {
  const aggregationFunction = normalizeMetricFunction(value);
  return aggregationFunction in AGGREGATION_TEMPLATES ? aggregationFunction : "COUNT";
}

/** A new behavior condition: performed the event at least once in the last 7 days. */
export function newBehaviorCondition(event = ""): BehaviorCondition {
  return { type: "behavior", event, measure: "COUNT", window: DEFAULT_WINDOW, op: ">=", value: 1 };
}

// A change to what the condition counts drops the metric id. Publish derives the id again.
function withMeasure(condition: BehaviorCondition, change: Pick<BehaviorCondition, "event" | "measure" | "attribute">): BehaviorCondition {
  const rest = without(condition, "attribute", "metric_id");
  return { ...rest, event: change.event, measure: change.measure, ...(change.attribute ? { attribute: change.attribute } : {}) };
}

interface BehaviorConditionRowProps {
  condition: BehaviorCondition;
  onChange: (condition: BehaviorCondition) => void;
  onDelete?: () => void;
  events: EventOption[];
  readOnly?: boolean;
}

export default function BehaviorConditionRow({
  condition,
  onChange,
  onDelete,
  events,
  readOnly,
}: BehaviorConditionRowProps) {
  const measure = templateFunction(condition.measure);
  const template = AGGREGATION_TEMPLATES[measure];
  const event = events.find((e) => e.name === condition.event);
  const fields = catalogFields(event);
  const compatibleFields = template.numericOnly ? fields.filter((f) => f.type === "number") : fields;
  const { window } = condition;

  const changeMeasure = (nextMeasure: string, attribute: string | undefined) => {
    const nextTemplate = AGGREGATION_TEMPLATES[nextMeasure];
    const nextFields = nextTemplate.numericOnly ? fields.filter((f) => f.type === "number") : fields;
    const nextAttribute = nextTemplate.needsField ? attribute || nextFields[0]?.value : undefined;
    const changed = withMeasure(condition, { event: condition.event, measure: nextMeasure, attribute: nextAttribute });
    onChange(nextMeasure === "INACTION" ? { ...changed, op: "=", value: 0 } : changed);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-background p-2.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-muted-foreground">Did</span>
        <Select
          value={condition.event}
          disabled={readOnly}
          onValueChange={(value) => onChange(withMeasure(condition, { event: String(value), measure, attribute: undefined }))}
        >
          <SelectTrigger aria-label="Behavior event" className="h-8 min-w-[140px] flex-1 bg-background text-[11px]">
            <SelectValue placeholder="Select an event">{event?.label || condition.event || undefined}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {events.map((e) => (
              <SelectItem key={e.id} value={e.name}>{e.label}</SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {onDelete && !readOnly && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete condition"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={measure} disabled={readOnly} onValueChange={(value) => changeMeasure(templateFunction(String(value)), condition.attribute)}>
          <SelectTrigger aria-label="Measure" className="h-8 min-w-[180px] flex-1 bg-background text-[11px]">
            <SelectValue>{template.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(AGGREGATION_TEMPLATES).map(([key, option]) => (
              <SelectItem key={key} value={key}>{option.label}</SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {template.needsField && (
          <Select
            value={condition.attribute ?? ""}
            disabled={readOnly || compatibleFields.length === 0}
            onValueChange={(value) => changeMeasure(measure, String(value))}
          >
            <SelectTrigger aria-label="Attribute" className="h-8 min-w-[140px] bg-background text-[11px]">
              <SelectValue placeholder="Select a property">
                {compatibleFields.find((f) => f.value === condition.attribute)?.label || condition.attribute || undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {compatibleFields.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {measure !== "INACTION" && (
          <>
            <Select
              value={condition.op}
              disabled={readOnly}
              onValueChange={(value) => onChange({ ...condition, op: value as BehaviorOperator })}
            >
              <SelectTrigger aria-label="Behavior operator" className="h-8 min-w-[110px] bg-background text-[11px]">
                <SelectValue>{AGGREGATION_OPERATOR_LABELS[condition.op] || condition.op}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(AGGREGATION_OPERATOR_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              type="number"
              value={Number.isFinite(condition.value) ? condition.value : ""}
              disabled={readOnly}
              onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
              aria-label="Behavior value"
              className="h-8 w-20 bg-background px-2 text-center text-[11px] font-bold"
            />
          </>
        )}
        <Select
          value={window.unit}
          disabled={readOnly}
          onValueChange={(value) => onChange({ ...condition, window: { value: window.value, unit: value as WindowUnit } })}
        >
          <SelectTrigger aria-label="Window unit" className="h-8 min-w-[150px] bg-background text-[11px]">
            <SelectValue>{`In the last N ${TIME_UNIT_LABELS[window.unit]}`}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(TIME_UNIT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>{`In the last N ${label}`}</SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          type="number"
          min={1}
          value={window.value}
          disabled={readOnly}
          onChange={(e) => onChange({ ...condition, window: { value: Math.max(1, Number(e.target.value)), unit: window.unit } })}
          aria-label="Window length"
          className="h-8 w-16 bg-background px-2 text-center text-[11px] font-bold"
        />
      </div>
    </div>
  );
}
