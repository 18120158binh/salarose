import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import ConditionSection from "./ConditionSection";
import EventSelectionCard from "./EventSelectionCard";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import {
  type EventOption,
  type FieldChangeHandler,
  type NodeConfig,
  type NodeUpdateHandler,
  catalogFields,
  defaultFieldsIn,
} from "./editorTypes";
import { Card, CardContent } from "@/components/ui/card";

export interface WatchNodeEditorProps {
  config: NodeConfig;
  handleFieldChange: FieldChangeHandler;
  onUpdate: NodeUpdateHandler;
  label: string;
  readOnly?: boolean;
  allEventsList: EventOption[];
  userProfileFields: FieldDef[];
}

export default function WatchNodeEditor({
  config,
  handleFieldChange,
  onUpdate,
  label,
  readOnly,
  allEventsList,
  userProfileFields,
}: WatchNodeEditorProps) {
  const watchType = config.watchType || "TimeoutPath";
  const timeLimitValue = config.timeLimitValue !== undefined ? config.timeLimitValue : 15;
  const timeLimitUnit = config.timeLimitUnit || "minutes";
  
  const selectedEventId = config.eventId || "";
  const eventNameFromCondition: string = config.eventName || "";
  
  const selectedEventDef = allEventsList.find(e => e.id === selectedEventId) 
    || allEventsList.find(e => e.name === eventNameFromCondition)
    || allEventsList.find(e => e.id === eventNameFromCondition);
  const activeEventValue = selectedEventDef ? selectedEventDef.id : (eventNameFromCondition || "");

  const defaultFields = defaultFieldsIn(config.filters);
  const metricFields = catalogFields(selectedEventDef);
  const dynamicFields: FieldDef[] = metricFields.filter(f => !defaultFields.includes(f.value));

  return (
    <Tabs defaultValue="paths" className="w-full">
      <TabsList className="w-full grid grid-cols-2 mb-4">
        <TabsTrigger value="paths">Paths</TabsTrigger>
        <TabsTrigger value="conditions" disabled={watchType === "DelayPath"}>Conditions</TabsTrigger>
      </TabsList>

      <TabsContent value="paths" className="space-y-4">
        {watchType !== "DelayPath" && (
          <EventSelectionCard
            label="1. Watch for event..."
            description="Select the event to monitor."
            handleFieldChange={handleFieldChange}
            allEventsList={allEventsList}
            activeEventValue={activeEventValue}
            eventNameFromCondition={eventNameFromCondition}
            readOnly={readOnly}
          />
        )}

        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="bg-primary/5 p-3 border-b border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
              2. Watch Paths
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Determine how long to wait and how to branch.</p>
          </div>
          <CardContent className="p-4 space-y-4">
            <Select
              disabled={readOnly}
              value={watchType}
              onValueChange={(val) => {
                const newVal = val || "TimeoutPath";
                handleFieldChange("watchType", newVal);
                onUpdate({ ...config, watchType: newVal }, label);
              }}
            >
              <SelectTrigger className="w-full border rounded-lg p-2 bg-background border-border">
                <SelectValue placeholder="Select outcome paths" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="DelayPath">⏱ Delay Only (Wait then proceed)</SelectItem>
                <SelectItem value="SuccessPath">Success Only (If event occurs)</SelectItem>
                <SelectItem value="TimeoutPath">Timeout Only (If event does not occur)</SelectItem>
                <SelectItem value="SuccessOrTimeoutPath">Success & Timeout Branches</SelectItem>
              </SelectPopup>
            </Select>

            {watchType === "DelayPath" && (
              <div className="p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">⏱ Pure Delay Mode</p>
                <p className="text-[11px] text-blue-600 dark:text-blue-400">This node will simply wait for the specified duration, then proceed to the next step. No event conditions are checked.</p>
              </div>
            )}

            <div className="space-y-2 pt-2 border-t border-border/50">
              <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
                Duration Limit
              </label>
              <div className="flex gap-2">
                <Input
                  disabled={readOnly}
                  type="number"
                  min="1"
                  value={timeLimitValue}
                  onChange={(e) => {
                    handleFieldChange("timeLimitValue", parseInt(e.target.value) || 1);
                    onUpdate({ ...config, timeLimitValue: parseInt(e.target.value) || 1 }, label);
                  }}
                  className="w-24 text-center font-bold border-border"
                />
                <Select
                  disabled={readOnly}
                  value={timeLimitUnit}
                  onValueChange={(val) => {
                    handleFieldChange("timeLimitUnit", val);
                    onUpdate({ ...config, timeLimitUnit: val }, label);
                  }}
                >
                  <SelectTrigger className="w-32 border border-border rounded-lg p-2 bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="seconds">Seconds</SelectItem>
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                    <SelectItem value="days">Days</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>
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
          events={allEventsList}
          readOnly={readOnly}
          isEventSelected={!!activeEventValue}
          defaultBehaviorEvent={selectedEventDef?.name}
        />
      </TabsContent>
    </Tabs>
  );
}
