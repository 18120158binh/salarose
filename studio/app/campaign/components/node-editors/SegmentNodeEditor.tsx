import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import { PersonConditionsEditor } from "./ConditionSection";
import type { EventOption, FieldChangeHandler, NodeConfig, NodeUpdateHandler } from "./editorTypes";

export interface SegmentNodeEditorProps {
  config: NodeConfig;
  handleFieldChange: FieldChangeHandler;
  onUpdate: NodeUpdateHandler;
  label: string;
  readOnly?: boolean;
  events?: EventOption[];
  userProfileFields?: FieldDef[];
}

// A condition split has no trigger. It fires Yes when its conditions hold, and publish requires
// a behavior condition, whose metric changes are what it is evaluated on.
export default function SegmentNodeEditor({
  config,
  handleFieldChange,
  onUpdate,
  label,
  readOnly,
  events = [],
  userProfileFields = [],
}: SegmentNodeEditorProps) {
  const checkType = config.checkType || "YesPath";
  // Older builds offered No paths for a segment. One saved then keeps its No path until the
  // marketer picks Yes Only, which deletes it.
  const hasOldNoPath = checkType === "NoPath" || checkType === "YesOrNoPath";
  const hasBehavior = (config.conditions?.groups ?? []).some((group: { conditions: { type: string }[] }) =>
    group.conditions.some((condition) => condition.type === "behavior"));

  return (
    <Tabs defaultValue="conditions" className="w-full">
      <TabsList className="w-full grid grid-cols-2 mb-4">
        <TabsTrigger value="conditions">Conditions</TabsTrigger>
        <TabsTrigger value="paths">Paths</TabsTrigger>
      </TabsList>

      <TabsContent value="conditions" className="space-y-4">
        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="bg-primary/5 p-3 border-b border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
              Conditions
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Users take Yes when every group passes. Add at least one behavior condition.</p>
          </div>
          <CardContent className="p-4 space-y-2">
            {!hasBehavior && !readOnly && (
              <p role="alert" className="text-xs text-destructive">Publish needs a behavior condition here.</p>
            )}
            <PersonConditionsEditor
              conditions={config.conditions}
              onChange={(conditions) => handleFieldChange("conditions", conditions)}
              profileFields={userProfileFields}
              events={events}
              readOnly={readOnly}
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="paths" className="space-y-4">
        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="bg-primary/5 p-3 border-b border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
              Outcome Paths
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Users take Yes when the segment matches. A segment has no No path.</p>
          </div>
          <CardContent className="p-4 space-y-4">
            {hasOldNoPath && (
              <p role="alert" className="text-xs text-destructive">
                This segment has a No path from an older version. Users never take No, so the nodes on it never run.
                Choose Yes Only to delete it.
              </p>
            )}
            <Select
              disabled={readOnly}
              value={checkType}
              onValueChange={(val) => {
                const newVal = val || "YesPath";
                handleFieldChange("checkType", newVal);
                onUpdate({ ...config, checkType: newVal }, label);
              }}
            >
              <SelectTrigger className="w-full border rounded-lg p-2 bg-background border-border">
                <SelectValue placeholder="Select outcome paths" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="YesPath">Yes Only (If match)</SelectItem>
                {checkType === "NoPath" && <SelectItem value="NoPath" disabled>No Only (never runs)</SelectItem>}
                {checkType === "YesOrNoPath" && <SelectItem value="YesOrNoPath" disabled>Yes & No Branches (No never runs)</SelectItem>}
              </SelectPopup>
            </Select>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
