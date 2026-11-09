import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem, ComboboxEmpty } from "@/components/ui/combobox";
import ConditionSection from "./ConditionSection";
import { FieldDef, eventFieldType } from "@/entities/journey/model/conditionConfig";
import { type EventOption, type FieldChangeHandler, type NodeConfig, defaultFieldsIn } from "./editorTypes";
import { defaultFiltersFor } from "@/entities/journey/model/eventCondition";
import { Card, CardContent } from "@/components/ui/card";

type ComboboxOption = { value: string; label: string };

export interface TriggerNodeEditorProps {
  config: NodeConfig;
  handleFieldChange: FieldChangeHandler;
  readOnly?: boolean;
  userEvents: EventOption[];
  businessEvents: EventOption[];
  userProfileFields: FieldDef[];
}

export default function TriggerNodeEditor({
  config,
  handleFieldChange,
  readOnly,
  userEvents,
  businessEvents,
  userProfileFields,
}: TriggerNodeEditorProps) {
  const triggerEventName: string | undefined = config.triggerEventName || config.eventName;

  const selectedTriggerEventId = config.eventId || "";
  const allSetupEvents = [...userEvents, ...businessEvents];
  const setupSelectedDef = allSetupEvents.find(e => e.id === selectedTriggerEventId)
    || allSetupEvents.find(e => e.name === triggerEventName)
    || allSetupEvents.find(e => e.id === triggerEventName);

  const activeValue = setupSelectedDef?.id || selectedTriggerEventId || triggerEventName || "";
  const setupEventItems = allSetupEvents.map(ev => ({
    value: ev.id,
    label: ev.label,
  }));
  const activeItem = setupEventItems.find(item => item.value === activeValue)
    || (activeValue
      ? {
          value: activeValue,
          label: setupSelectedDef?.label || triggerEventName || activeValue,
        }
      : null);
  
  const defaultFields = defaultFieldsIn(config.filters);
  const dynamicFields: FieldDef[] = (setupSelectedDef?.fields ?? [])
    .filter((f) => !defaultFields.includes(f.value))
    .map((f) => ({ ...f, group: "event" as const, type: eventFieldType(f) }));

  return (
    <Tabs defaultValue="core" className="w-full">
      <TabsList className="w-full grid grid-cols-3 mb-4">
        <TabsTrigger value="core">Core Setup</TabsTrigger>
        <TabsTrigger value="conditions">Conditions</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>

      <TabsContent value="core" className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Campaign Description
          </label>
          <Input
            value={config.description || ""}
            onChange={(e) => handleFieldChange("description", e.target.value)}
            placeholder="e.g. Back in Stock notification flow"
            disabled={readOnly}
          />
        </div>

        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="bg-primary/5 p-3 border-b border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
              Entry Trigger Event
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Users enter the journey when this event fires.</p>
          </div>
          <CardContent className="p-4 space-y-4">
            <Combobox
              items={setupEventItems}
              value={activeItem}
              onValueChange={(val: ComboboxOption | null) => {
                if (!val || readOnly) return;
                const def = userEvents.find(e => e.id === val.value) || businessEvents.find(e => e.id === val.value);
                if (def && def.id !== activeValue) {
                  handleFieldChange("eventId", def.id);
                  handleFieldChange("triggerEventName", def.name);
                  handleFieldChange("eventName", def.name);
                  const defaults = defaultFiltersFor(def);
                  handleFieldChange("filters", defaults.groups.length > 0 ? defaults : undefined);
                }
              }}
            >
              <ComboboxInput disabled={readOnly} placeholder="Choose trigger event..." className="w-full border rounded-lg bg-background border-border" />
              <ComboboxPopup>
                <ComboboxEmpty>No results found.</ComboboxEmpty>
                <ComboboxList>
                  {(item: ComboboxOption) => <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="conditions">
        <ConditionSection
          filters={config.filters}
          onFiltersChange={(filters) => handleFieldChange("filters", filters)}
          conditions={config.conditions}
          onConditionsChange={(conditions) => handleFieldChange("conditions", conditions)}
          availableEventFields={dynamicFields}
          availableProfileFields={userProfileFields}
          events={userEvents}
          readOnly={readOnly}
          isEventSelected={!!activeValue}
          defaultBehaviorEvent={setupSelectedDef?.name}
        />
      </TabsContent>

      <TabsContent value="advanced" className="space-y-4">
        <div className="text-xs text-muted-foreground italic border border-dashed border-border/50 rounded-lg p-6 text-center bg-muted/10">
          No advanced settings available for User Event triggers.
        </div>
      </TabsContent>
    </Tabs>
  );
}
