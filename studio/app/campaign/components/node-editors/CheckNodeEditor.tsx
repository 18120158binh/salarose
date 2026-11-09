import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import ConditionSection, { EventFiltersEditor, PersonConditionsEditor } from "./ConditionSection";
import EventSelectionCard from "./EventSelectionCard";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import type { BranchConfig } from "@/entities/journey/model/utils";
import {
  type EventOption,
  type FieldChangeHandler,
  type NodeConfig,
  type NodeUpdateHandler,
  catalogFields,
  defaultFieldsIn,
} from "./editorTypes";
import { Card, CardContent } from "@/components/ui/card";

export interface CheckNodeEditorProps {
  config: NodeConfig;
  handleFieldChange: FieldChangeHandler;
  onUpdate: NodeUpdateHandler;
  label: string;
  readOnly?: boolean;
  allEventsList: EventOption[];
  userProfileFields: FieldDef[];
}

function nextBranchIndex(branches: BranchConfig[]): number {
  const usedIndexes = branches
    .map((branch) => /^branch_(\d+)$/.exec(String(branch.branchKey)))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));

  return usedIndexes.length === 0 ? 0 : Math.max(...usedIndexes) + 1;
}

function nextBranchPriority(branches: BranchConfig[]): number {
  const priorities = branches
    .map((branch) => Number(branch.priority))
    .filter(Number.isFinite);

  return priorities.length === 0 ? 0 : Math.max(...priorities) + 1;
}

function branchLetter(index: number): string {
  let current = index + 1;
  let result = "";

  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }

  return result;
}

function normalizeBranchIdentities(branches: BranchConfig[]): BranchConfig[] {
  const indexesByKey = new Map<string, number[]>();
  branches.forEach((branch, index) => {
    const key = String(branch.branchKey || "");
    indexesByKey.set(key, [...(indexesByKey.get(key) || []), index]);
  });

  const canonicalIndexByKey = new Map<string, number>();
  indexesByKey.forEach((indexes, key) => {
    if (!key || indexes.length < 2) return;

    const suffixMatch = /^branch_(\d+)$/.exec(key);
    const suffix = suffixMatch ? Number(suffixMatch[1]) : null;
    const expectedLabel =
      suffix === null ? null : `Branch ${branchLetter(suffix)}`;
    const canonicalIndex =
      indexes.find((index) => branches[index].label === expectedLabel)
      ?? indexes.find((index) => Number(branches[index].priority) === suffix)
      ?? indexes[0];
    canonicalIndexByKey.set(key, canonicalIndex);
  });

  const usedKeys = new Set<string>();
  let replacementIndex = nextBranchIndex(branches);
  let replacementPriority = nextBranchPriority(branches);

  return branches.map((branch, index) => {
    const key = String(branch.branchKey || "");
    const canonicalIndex = canonicalIndexByKey.get(key);
    const canKeepKey =
      key.length > 0
      && !usedKeys.has(key)
      && (canonicalIndex === undefined || canonicalIndex === index);

    if (canKeepKey) {
      usedKeys.add(key);
      return branch;
    }

    let replacementKey = `branch_${replacementIndex}`;
    while (usedKeys.has(replacementKey)) {
      replacementIndex += 1;
      replacementKey = `branch_${replacementIndex}`;
    }
    usedKeys.add(replacementKey);

    const normalized = {
      ...branch,
      branchKey: replacementKey,
      priority: replacementPriority,
    };
    replacementIndex += 1;
    replacementPriority += 1;
    return normalized;
  });
}

export default function CheckNodeEditor({
  config,
  handleFieldChange,
  onUpdate,
  label,
  readOnly,
  allEventsList,
  userProfileFields,
}: CheckNodeEditorProps) {
  const checkType = config.checkType || "YesOrNoPath";
  const branches = React.useMemo(
    () => normalizeBranchIdentities(config.branches || []),
    [config.branches],
  );
  const branchIdentityWasRepaired = branches.some(
    (branch, index) => branch !== config.branches?.[index],
  );

  React.useEffect(() => {
    if (branchIdentityWasRepaired) {
      handleFieldChange("branches", branches);
    }
  }, [branchIdentityWasRepaired, branches, handleFieldChange]);

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
    <Tabs defaultValue="conditions" className="w-full">
      <TabsList className="w-full grid grid-cols-2 mb-4">
        <TabsTrigger value="conditions">Conditions</TabsTrigger>
        <TabsTrigger value="paths">Outcome Paths</TabsTrigger>
      </TabsList>

      <TabsContent value="conditions" className="space-y-4">
        <EventSelectionCard
          label="What event are we checking?"
          description="Select the event this check evaluates."
          handleFieldChange={handleFieldChange}
          allEventsList={allEventsList}
          activeEventValue={activeEventValue}
          eventNameFromCondition={eventNameFromCondition}
          readOnly={readOnly}
        />

        <ConditionSection
          filters={config.filters}
          onFiltersChange={(filters) => {
            handleFieldChange("filters", filters);
            onUpdate({ ...config, filters }, label);
          }}
          conditions={config.conditions}
          onConditionsChange={(conditions) => {
            handleFieldChange("conditions", conditions);
            onUpdate({ ...config, conditions }, label);
          }}
          availableEventFields={dynamicFields}
          availableProfileFields={userProfileFields}
          events={allEventsList}
          readOnly={readOnly}
          isEventSelected={!!activeEventValue}
          defaultBehaviorEvent={selectedEventDef?.name}
        />
      </TabsContent>

      <TabsContent value="paths" className="space-y-4">
        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="bg-primary/5 p-3 border-b border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
              Outcome Paths
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Determine how users flow after this check.</p>
          </div>
          <CardContent className="p-4 space-y-4">
            <Select
              disabled={readOnly}
              value={checkType}
              onValueChange={(val) => {
                const newVal = val || "YesOrNoPath";
                handleFieldChange("checkType", newVal);
                if (newVal === "MultiBranchPath" && !config.branches) {
                  handleFieldChange("branches", [
                    { branchKey: "branch_0", priority: 0, label: "Branch A" },
                    { branchKey: "branch_1", priority: 1, label: "Branch B" },
                  ]);
                }
                onUpdate({ ...config, checkType: newVal, ...(newVal === "MultiBranchPath" && !config.branches ? { branches: [
                  { branchKey: "branch_0", priority: 0, label: "Branch A" },
                  { branchKey: "branch_1", priority: 1, label: "Branch B" },
                ]} : {}) }, label);
              }}
            >
              <SelectTrigger className="w-full border rounded-lg p-2 bg-background border-border">
                <SelectValue placeholder="Select outcome paths" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="YesPath">Yes Only (If true)</SelectItem>
                <SelectItem value="NoPath">No Only (If false)</SelectItem>
                <SelectItem value="YesOrNoPath">Yes & No Branches</SelectItem>
                <SelectItem value="MultiBranchPath">Multi-Branch (Fan-Out)</SelectItem>
              </SelectPopup>
            </Select>

            {checkType === "MultiBranchPath" && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Branch Configurations
                    </label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      All matching branches will fire simultaneously.
                    </p>
                  </div>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        const nextBranches = [...branches];
                        const branchIndex = nextBranchIndex(nextBranches);
                        nextBranches.push({
                          branchKey: `branch_${branchIndex}`,
                          priority: nextBranchPriority(nextBranches),
                          label: `Branch ${branchLetter(branchIndex)}`,
                        });
                        handleFieldChange("branches", nextBranches);
                      }}
                    >
                      + Add Branch
                    </Button>
                  )}
                </div>
                
                <div className="border border-border/50 rounded-lg overflow-hidden">
                  <Accordion>
                    {branches.map((branch, idx) => (
                      <AccordionItem key={branch.branchKey} value={branch.branchKey} className="border-border/50 bg-background">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
                          <AccordionTrigger className="min-w-0 px-3 py-2 hover:bg-muted/30">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary/70">
                                {branch.branchKey}
                              </span>
                              <span className="truncate text-xs font-medium text-foreground">
                                {branch.label || `Branch ${idx + 1}`}
                              </span>
                            </div>
                          </AccordionTrigger>
                          {!readOnly && branches.length > 2 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-label={`Delete ${branch.label || branch.branchKey}`}
                              onClick={() => {
                                const nextBranches = branches.filter((_, i) => i !== idx);
                                handleFieldChange("branches", nextBranches);
                                onUpdate({ ...config, branches: nextBranches }, label);
                              }}
                              className="mr-2 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                        <AccordionContent className="bg-muted/10 p-3 border-t border-border/50">
                          <div className="space-y-3">
                            <div className="space-y-1.5">
                              <label
                                htmlFor={`branch-label-${branch.branchKey}`}
                                className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
                              >
                                Branch name
                              </label>
                              <Input
                                id={`branch-label-${branch.branchKey}`}
                                disabled={readOnly}
                                value={branch.label || ""}
                                onChange={(e) => {
                                  const nextBranches = [...branches];
                                  nextBranches[idx] = { ...nextBranches[idx], label: e.target.value };
                                  handleFieldChange("branches", nextBranches);
                                }}
                                placeholder="Branch name"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Event filters</span>
                              <EventFiltersEditor
                                filters={branch.filters}
                                onChange={(filters) => {
                                  const nextBranches = [...branches];
                                  nextBranches[idx] = { ...nextBranches[idx], filters };
                                  handleFieldChange("branches", nextBranches);
                                }}
                                availableFields={dynamicFields}
                                readOnly={readOnly}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Person conditions</span>
                              <PersonConditionsEditor
                                conditions={branch.conditions}
                                onChange={(conditions) => {
                                  const nextBranches = [...branches];
                                  nextBranches[idx] = { ...nextBranches[idx], conditions };
                                  handleFieldChange("branches", nextBranches);
                                }}
                                profileFields={userProfileFields}
                                events={allEventsList}
                                readOnly={readOnly}
                                defaultBehaviorEvent={selectedEventDef?.name}
                              />
                            </div>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
