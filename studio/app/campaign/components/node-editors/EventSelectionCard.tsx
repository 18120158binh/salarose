import React from "react";
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem, ComboboxEmpty } from "@/components/ui/combobox";
import { Card, CardContent } from "@/components/ui/card";
import { defaultFiltersFor } from "@/entities/journey/model/eventCondition";
import type { EventOption, FieldChangeHandler } from "./editorTypes";

type ComboboxOption = { value: string; label: string };

export interface EventSelectionCardProps {
  label: string;
  description?: string;
  handleFieldChange: FieldChangeHandler;
  allEventsList: EventOption[];
  activeEventValue: string;
  eventNameFromCondition: string;
  readOnly?: boolean;
}

export default function EventSelectionCard({
  label,
  description,
  handleFieldChange,
  allEventsList,
  activeEventValue,
  eventNameFromCondition,
  readOnly,
}: EventSelectionCardProps) {
  return (
    <Card className="border-primary/20 shadow-sm overflow-hidden">
      <div className="bg-primary/5 p-3 border-b border-primary/10">
        <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
          {label}
        </label>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <CardContent className="p-4">
        <Combobox
          items={allEventsList.map(ev => ({ value: ev.id, label: ev.label }))}
          value={
            allEventsList.map(ev => ({ value: ev.id, label: ev.label })).find(i => i.value === activeEventValue) 
            || (activeEventValue ? { value: activeEventValue, label: allEventsList.find(e => e.name === activeEventValue || e.id === activeEventValue)?.label || activeEventValue } : null)
            || (eventNameFromCondition ? { value: eventNameFromCondition, label: allEventsList.find(e => e.name === eventNameFromCondition || e.id === eventNameFromCondition)?.label || eventNameFromCondition } : null)
          }
          onValueChange={(val: ComboboxOption | null) => {
            if (!val || readOnly) return;
            const newEventDef = allEventsList.find(e => e.id === val.value);
            if (newEventDef && activeEventValue !== newEventDef.id) {
              handleFieldChange("eventId", newEventDef.id);
              handleFieldChange("eventName", newEventDef.name);
              // The filters of another event name its attributes, so a new event starts with its own defaults.
              const defaults = defaultFiltersFor(newEventDef);
              handleFieldChange("filters", defaults.groups.length > 0 ? defaults : undefined);
            }
          }}
        >
          <ComboboxInput disabled={readOnly} placeholder="Choose an event..." className="w-full border rounded-lg bg-background border-border" />
          <ComboboxPopup>
            <ComboboxEmpty>No results found.</ComboboxEmpty>
            <ComboboxList>
              {(item: ComboboxOption) => <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </CardContent>
    </Card>
  );
}
