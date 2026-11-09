import React from "react";
import type { ConditionGroup, ConditionGroups, FieldOperator, FieldValue } from "@/entities/journey/model/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectPopup, SelectItem, SelectGroup, SelectLabel } from "@/components/ui/select";
import { CONTAINS, FieldDef, FIELD_GROUPS, OPERATOR_CONFIG, editorOperator, editorValue, operatorLabel, savedComparison } from "@/entities/journey/model/conditionConfig";
import { typedValue } from "@/entities/journey/model/eventCondition";

// The decision job compares a boolean as the text "true" or "false".
const BOOLEAN_VALUES = ["true", "false"];

/** A comparison of an event or a profile field. */
export interface FieldComparison {
  field: string;
  op: FieldOperator;
  value: FieldValue;
  isDefault?: true;
}

interface FieldConditionRowProps<C extends FieldComparison> {
  condition: C;
  onChange: (condition: C) => void;
  onDelete?: () => void;
  readOnly?: boolean;
  availableFields: FieldDef[];
}

function displayName(systemName: string): string {
  const name = systemName.split(".").pop() || "";
  return name.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function FieldConditionRow<C extends FieldComparison>({
  condition,
  onChange,
  onDelete,
  readOnly = false,
  availableFields,
}: FieldConditionRowProps<C>) {
  const fieldDef = availableFields.find((f) => f.value === condition.field);
  const fieldType = fieldDef?.type ?? "string";
  const operator = editorOperator(condition);
  const shownValue = editorValue(condition);
  // The typed text, kept while it reads as the saved value, so that "Hanoi, " or "1." can be typed.
  const [draft, setDraft] = React.useState(shownValue);
  const draftMatches = editorValue({ ...condition, ...save(operator, draft, fieldType) }) === shownValue;
  const text = draftMatches ? draft : shownValue;

  function save(nextOperator: string, nextText: string, nextType: string) {
    const { op, text: savedText } = savedComparison(nextOperator, nextText);
    return { op, value: typedValue(op, savedText, nextType) };
  }

  const update = (nextOperator: string, nextText: string, nextType = fieldType) => {
    setDraft(nextText);
    onChange({ ...condition, ...save(nextOperator, nextText, nextType) });
  };

  const changeField = (field: string) => {
    const nextDef = availableFields.find((f) => f.value === field);
    const nextType = nextDef?.type ?? "string";
    const config = OPERATOR_CONFIG[operator];
    const nextOperator = config && !config.types.includes("all") && !config.types.includes(nextType) ? "=" : operator;
    const nextText = nextType === "boolean" && !BOOLEAN_VALUES.includes(text) ? "" : text;
    setDraft(nextText);
    onChange({ ...condition, field, ...save(nextOperator, nextText, nextType) });
  };

  // The current operator stays listed, so that a row saved by an older build shows what it does.
  const allowedOperators = Object.entries(OPERATOR_CONFIG)
    .filter(([op, config]) => config.types.includes("all") || config.types.includes(fieldType) || op === operator)
    .map(([op]) => ({ value: op, label: operatorLabel(op, fieldType) }));

  const groupedFields = availableFields.reduce((acc, field) => {
    (acc[field.group] ||= []).push(field);
    return acc;
  }, {} as Record<string, FieldDef[]>);

  const disabled = readOnly || condition.isDefault === true;

  return (
    <div className="flex flex-wrap items-center gap-2 bg-muted/30 border border-border/40 rounded-lg p-2.5 w-full text-foreground text-[11px]">
      <Select value={condition.field} onValueChange={(val) => changeField(String(val))} disabled={disabled}>
        <SelectTrigger aria-label="Field" className="text-[11px] min-w-[120px] h-8 flex-1 bg-background">
          <span>{fieldDef?.label || displayName(condition.field) || "Select property"}</span>
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(groupedFields).map(([groupKey, fields]) => (
            <SelectGroup key={groupKey}>
              <SelectLabel className="text-[10px] font-bold text-muted-foreground uppercase px-2 py-1 bg-muted/20">
                {FIELD_GROUPS[groupKey] || groupKey}
              </SelectLabel>
              {fields.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectGroup>
          ))}
          {condition.field.trim().length > 0 && !fieldDef && (
            <SelectItem value={condition.field}>{displayName(condition.field)}</SelectItem>
          )}
        </SelectPopup>
      </Select>

      <Select value={operator} onValueChange={(val) => update(String(val), text)} disabled={disabled}>
        <SelectTrigger aria-label="Operator" className="text-[11px] min-w-[100px] h-8 shrink-0 bg-background">
          <span>{operatorLabel(operator, fieldType)}</span>
        </SelectTrigger>
        <SelectPopup>
          {allowedOperators.map((op) => (
            <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
          ))}
        </SelectPopup>
      </Select>

      {fieldType === "boolean" ? (
        <Select value={text} onValueChange={(val) => update(operator, String(val))} disabled={disabled}>
          <SelectTrigger aria-label="Value" className="text-[11px] min-w-[120px] h-8 flex-1 bg-background">
            <span>{text || "Select value"}</span>
          </SelectTrigger>
          <SelectPopup>
            {BOOLEAN_VALUES.map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          aria-label="Value"
          value={text}
          onChange={(e) => update(operator, e.target.value)}
          disabled={disabled}
          type={fieldType === "number" && operator !== "IN" ? "number" : "text"}
          placeholder={operator === "IN" ? "val1, val2" : fieldType === "datetime" ? "2026-10-01 or 2026-10-01T09:00:00Z" : "enter value..."}
          className="h-8 text-[11px] flex-1 min-w-[120px] px-2 bg-background border-border"
        />
      )}

      {operator === CONTAINS && text === "" && (
        <p role="alert" className="basis-full text-[10px] text-destructive">
          Enter the text to look for. A blank contains would match every value, so publish refuses it.
        </p>
      )}
      {operator === CONTAINS && /[%_]/.test(text) && (
        <p className="basis-full text-[10px] text-muted-foreground">
          % matches any text and _ matches any one character here.
        </p>
      )}

      {onDelete && !disabled && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete condition"
          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A kind of condition the marketer can add, such as a profile field or a behavior. */
export interface ConditionKind<C> {
  label: string;
  create: () => C;
}

interface ConditionGroupsEditorProps<C> {
  groups?: ConditionGroups<C> | null;
  /** Undefined when no group is left. */
  onChange: (groups: ConditionGroups<C> | undefined) => void;
  kinds: ConditionKind<C>[];
  renderCondition: (condition: C, onChange: (condition: C) => void, onDelete: () => void) => React.ReactNode;
  /** A group the marketer cannot edit, such as the catalog default rows. */
  isLocked?: (group: ConditionGroup<C>) => boolean;
  readOnly?: boolean;
}

/**
 * Edits a list of groups: every group must pass, and a group passes when any of its conditions
 * passes. Deleting a group's last condition deletes the group, so no group is ever empty.
 */
export default function ConditionGroupsEditor<C>({
  groups: groupsProp,
  onChange,
  kinds,
  renderCondition,
  isLocked = () => false,
  readOnly = false,
}: ConditionGroupsEditorProps<C>) {
  const groups = groupsProp?.groups ?? [];

  const emit = (next: ConditionGroup<C>[]) => {
    const kept = next.filter((group) => group.conditions.length > 0);
    onChange(kept.length > 0 ? { groups: kept } : undefined);
  };

  const setConditions = (groupIndex: number, conditions: C[]) =>
    emit(groups.map((group, i) => (i === groupIndex ? { conditions } : group)));

  return (
    <div className="space-y-2 w-full text-foreground">
      {groups.length === 0 && (
        <p className="text-[10px] text-muted-foreground italic py-1">No conditions. Everyone passes.</p>
      )}
      {groups.map((group, groupIndex) => {
        const locked = readOnly || isLocked(group);
        return (
          <div key={groupIndex}>
            {groupIndex > 0 && (
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground my-1">and</div>
            )}
            <div role="group" aria-label={`Group ${groupIndex + 1}`} className="border border-border/50 rounded-lg p-2.5 space-y-1.5">
              {group.conditions.map((condition, conditionIndex) => (
                <div key={conditionIndex}>
                  {conditionIndex > 0 && (
                    <div className="text-[10px] font-medium text-muted-foreground ml-2 mb-1">or</div>
                  )}
                  {renderCondition(
                    condition,
                    (next) => setConditions(groupIndex, group.conditions.map((c, i) => (i === conditionIndex ? next : c))),
                    () => setConditions(groupIndex, group.conditions.filter((_, i) => i !== conditionIndex)),
                  )}
                </div>
              ))}
              {!locked && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {kinds.map((kind) => (
                    <Button
                      key={kind.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setConditions(groupIndex, [...group.conditions, kind.create()])}
                    >
                      + Or {kind.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((kind) => (
            <Button
              key={kind.label}
              type="button"
              variant="outline"
              size="xs"
              onClick={() => emit([...groups, { conditions: [kind.create()] }])}
            >
              + And {kind.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
