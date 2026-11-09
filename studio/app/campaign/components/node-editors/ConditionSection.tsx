import React from "react";
import ConditionGroupsEditor, { FieldConditionRow } from "../ConditionGroupsEditor";
import type { EventFilters, EventPropertyCondition, PersonCondition, PersonConditions } from "@/entities/journey/model/types";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import { isDefaultGroup } from "@/entities/journey/model/eventCondition";
import BehaviorConditionRow, { newBehaviorCondition } from "./BehaviorConditionRow";
import type { EventOption } from "./editorTypes";
import { Card, CardContent } from "@/components/ui/card";

interface EventFiltersEditorProps {
  filters?: EventFilters | null;
  onChange: (filters: EventFilters | undefined) => void;
  availableFields: FieldDef[];
  readOnly?: boolean;
}

/** The trigger's filters, as groups of event properties. Catalog default groups are locked. */
export function EventFiltersEditor({ filters, onChange, availableFields, readOnly }: EventFiltersEditorProps) {
  return (
    <ConditionGroupsEditor<EventPropertyCondition>
      groups={filters}
      onChange={onChange}
      isLocked={isDefaultGroup}
      readOnly={readOnly}
      kinds={[{
        label: "event property",
        create: () => ({ type: "event_property", field: availableFields[0]?.value ?? "", op: "=", value: "" }),
      }]}
      renderCondition={(condition, change, remove) => (
        <FieldConditionRow condition={condition} onChange={change} onDelete={remove} readOnly={readOnly} availableFields={availableFields} />
      )}
    />
  );
}

interface PersonConditionsEditorProps {
  conditions?: PersonConditions | null;
  onChange: (conditions: PersonConditions | undefined) => void;
  profileFields: FieldDef[];
  events: EventOption[];
  readOnly?: boolean;
  /** The event a new behavior condition starts on. */
  defaultBehaviorEvent?: string;
}

/** The person conditions: profile fields and behaviors, which may share a group. */
export function PersonConditionsEditor({
  conditions,
  onChange,
  profileFields,
  events,
  readOnly,
  defaultBehaviorEvent,
}: PersonConditionsEditorProps) {
  return (
    <ConditionGroupsEditor<PersonCondition>
      groups={conditions}
      onChange={onChange}
      readOnly={readOnly}
      kinds={[
        {
          label: "profile field",
          create: () => ({ type: "profile_property", field: profileFields[0]?.value ?? "", op: "=", value: "" }),
        },
        { label: "behavior", create: () => newBehaviorCondition(defaultBehaviorEvent) },
      ]}
      renderCondition={(condition, change, remove) =>
        condition.type === "behavior" ? (
          <BehaviorConditionRow
            condition={condition}
            onChange={change}
            onDelete={remove}
            events={events}
            readOnly={readOnly}
          />
        ) : (
          <FieldConditionRow condition={condition} onChange={change} onDelete={remove} readOnly={readOnly} availableFields={profileFields} />
        )}
    />
  );
}

interface ConditionSectionProps {
  filters?: EventFilters | null;
  onFiltersChange?: (filters: EventFilters | undefined) => void;
  conditions?: PersonConditions | null;
  onConditionsChange: (conditions: PersonConditions | undefined) => void;
  availableEventFields?: FieldDef[];
  availableProfileFields: FieldDef[];
  events?: EventOption[];
  readOnly?: boolean;
  isEventSelected: boolean;
  eventConditionLabel?: string;
  defaultBehaviorEvent?: string;
}

export default function ConditionSection({
  filters,
  onFiltersChange,
  conditions,
  onConditionsChange,
  availableEventFields = [],
  availableProfileFields,
  events = [],
  readOnly,
  isEventSelected,
  eventConditionLabel = "Event Filters",
  defaultBehaviorEvent,
}: ConditionSectionProps) {
  return (
    <div className="space-y-4 pt-2">
      {onFiltersChange && (
        <Card className="shadow-none border-border/50">
          <div className="p-3 bg-muted/30 border-b border-border/50">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{eventConditionLabel}</h4>
            <p className="text-[10px] text-muted-foreground mt-0.5">The event passes when every group passes, and a group passes when any of its rows does.</p>
          </div>
          <CardContent className="p-4">
            {isEventSelected ? (
              <EventFiltersEditor filters={filters} onChange={onFiltersChange} availableFields={availableEventFields} readOnly={readOnly} />
            ) : (
              <div className="text-xs text-muted-foreground italic border border-dashed border-border/50 rounded-lg p-6 text-center bg-muted/10">
                Select an event before configuring event filters.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="shadow-none border-border/50">
        <div className="p-3 bg-muted/30 border-b border-border/50">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Person Conditions</h4>
          <p className="text-[10px] text-muted-foreground mt-0.5">Profile fields and past behavior. Every group must pass, and a group passes when any of its rows does.</p>
        </div>
        <CardContent className="p-4">
          <PersonConditionsEditor
            conditions={conditions}
            onChange={onConditionsChange}
            profileFields={availableProfileFields}
            events={events}
            readOnly={readOnly}
            defaultBehaviorEvent={defaultBehaviorEvent}
          />
        </CardContent>
      </Card>
    </div>
  );
}
