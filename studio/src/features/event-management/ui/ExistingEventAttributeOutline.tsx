"use client";

import type { UserEventFieldDef } from "@/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildEventAttributeTree,
  isEventAttributeInSubtree,
  type EventAttributeTreeNode,
} from "@/features/event-management/model/eventAttributeTree";
import { EventAttributeTreeConnector } from "@/features/event-management/ui/EventAttributeTreeConnector";
import { EVENT_ATTRIBUTE_TYPES } from "shared/lib/eventCatalog";
import {
  CheckIcon,
  ChevronDown,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Trash2,
  XIcon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useId, useState } from "react";

export interface ExistingEventAttributeEdit {
  eventId: string;
  originalPath: string;
  path: string;
  name: string;
  type: string;
  example: string;
  defaultValue: string;
}

interface ExistingEventAttributeOutlineProps {
  createForm: ReactNode;
  createFormParentPath: string | null;
  editingField: ExistingEventAttributeEdit | null;
  fields: UserEventFieldDef[];
  isCreateFormOpen: boolean;
  // The event's item key. Neither it nor an ancestor can be renamed or deleted.
  itemKey: string | null;
  onAdd: (parentPath: string | null) => void;
  onCancelEdit: () => void;
  onDelete: (fieldPath: string) => void;
  onEditChange: (changes: Partial<ExistingEventAttributeEdit>) => void;
  onRequiredChange: (fieldPath: string, required: boolean) => void;
  onSaveEdit: () => void;
  onStartEdit: (
    field: UserEventFieldDef,
    leafKey: string,
  ) => void;
}

// Why the attribute at path cannot be renamed or deleted, or null when it can.
function itemKeyLockReason(path: string, itemKey: string | null): string | null {
  if (itemKey === null || !isEventAttributeInSubtree(itemKey, path)) return null;
  return itemKey === path ? "Item key. It cannot be renamed or deleted." : `Holds the item key ${itemKey}.`;
}

// A control that stays focusable and announced while it is locked, with the reason as a tooltip.
function LockedControl({ reason, control }: { reason: string; control: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={control} />
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

const OUTLINE_COLUMNS =
  "grid min-w-[1040px] grid-cols-[minmax(300px,1.5fr)_120px_80px_minmax(150px,.8fr)_minmax(120px,.6fr)_240px]";

function AttributeNode({
  createForm,
  createFormParentPath,
  depth,
  editingField,
  isCreateFormOpen,
  itemKey,
  node,
  onAdd,
  onCancelEdit,
  onDelete,
  onEditChange,
  onRequiredChange,
  onSaveEdit,
  onStartEdit,
}: Omit<ExistingEventAttributeOutlineProps, "fields"> & {
  depth: number;
  node: EventAttributeTreeNode<UserEventFieldDef>;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const field = node.attribute;
  const hasChildren = node.children.length > 0;
  const isEditing =
    field !== null &&
    editingField?.originalPath === field.value;
  const displayName =
    field?.label ||
    node.key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const type = field?.dataType || (hasChildren ? "json" : "string");
  const isCreateFormHere =
    isCreateFormOpen && createFormParentPath === node.path;
  const lockReason = field ? itemKeyLockReason(field.value, itemKey) : null;
  const lockReasonId = useId();

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <div
        className={[
          `${OUTLINE_COLUMNS} items-center border-t`,
          hasChildren ? "bg-muted/20" : "bg-background",
        ].join(" ")}
        aria-selected={false}
        role="treeitem"
      >
        <div
          className="relative flex min-w-0 items-center gap-2 px-3 py-2"
          style={{ paddingInlineStart: `${depth * 24 + 12}px` }}
        >
          <EventAttributeTreeConnector depth={depth} inset={13} />
          {hasChildren ? (
            <CollapsibleTrigger
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.path}`}
              render={
                <Button
                  className="relative shrink-0"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {isOpen ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
            </CollapsibleTrigger>
          ) : (
            <span aria-hidden="true" className="relative block size-6" />
          )}

          {isEditing ? (
            <div className="relative grid min-w-0 flex-1 grid-cols-2 gap-2">
              {lockReason ? (
                <LockedControl
                  control={
                    <Input
                      aria-describedby={lockReasonId}
                      aria-disabled="true"
                      aria-label={`Attribute key for ${node.path}`}
                      className="h-8 min-w-0 font-mono text-xs opacity-64"
                      readOnly
                      type="text"
                      value={editingField.path}
                    />
                  }
                  reason={lockReason}
                />
              ) : (
                <Input
                  aria-label={`Attribute key for ${node.path}`}
                  className="h-8 min-w-0 font-mono text-xs"
                  onChange={(event) =>
                    onEditChange({ path: event.target.value })
                  }
                  pattern="[^.]+"
                  required
                  title="Enter one attribute key without dots."
                  type="text"
                  value={editingField.path}
                />
              )}
              <Input
                aria-label={`Display name for ${node.path}`}
                className="h-8 min-w-0 text-xs"
                onChange={(event) =>
                  onEditChange({ name: event.target.value })
                }
                type="text"
                value={editingField.name}
              />
            </div>
          ) : (
            <div className="relative min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-semibold">
                  {displayName}
                </span>
                {itemKey !== null && field?.value === itemKey && (
                  <Badge className="shrink-0 font-normal" variant="info">
                    <Lock aria-hidden="true" />
                    Item key
                  </Badge>
                )}
                {hasChildren && (
                  <Badge
                    className="shrink-0 font-normal"
                    variant="secondary"
                  >
                    {node.children.length}{" "}
                    {node.children.length === 1 ? "child" : "children"}
                  </Badge>
                )}
              </div>
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={node.path}
              >
                {node.key}
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 px-3 py-2">
          {isEditing ? (
            <Select
              disabled={hasChildren}
              onValueChange={(value) => {
                if (!value) return;
                onEditChange({
                  type: value,
                  ...(value === "json" ? { example: "", defaultValue: "" } : {}),
                });
              }}
              value={editingField.type}
            >
              <SelectTrigger
                aria-label={`Data type for ${node.path}`}
                className="h-8 min-w-0 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_ATTRIBUTE_TYPES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge
              className="font-normal capitalize"
              variant={type === "json" ? "secondary" : "outline"}
            >
              {type === "json" ? "JSON object" : type}
            </Badge>
          )}
        </div>

        <div className="px-3 py-2">
          {field && (
            <Checkbox
              aria-label={`${node.path} required`}
              checked={field.required === true}
              onCheckedChange={(checked) =>
                onRequiredChange(field.value, checked === true)
              }
            />
          )}
        </div>

        <div className="min-w-0 px-3 py-2">
          {isEditing ? (
            <Input
              aria-label={`Example value for ${node.path}`}
              className="h-8 min-w-0 text-xs"
              disabled={editingField.type === "json" || hasChildren}
              onChange={(event) =>
                onEditChange({ example: event.target.value })
              }
              placeholder={
                editingField.type === "json" || hasChildren
                  ? "Defined by children"
                  : "—"
              }
              type="text"
              value={editingField.example}
            />
          ) : (
            <span
              className="block truncate text-xs text-muted-foreground"
              title={field?.exampleValue || undefined}
            >
              {field?.exampleValue || "—"}
            </span>
          )}
        </div>

        <div className="min-w-0 px-3 py-2">
          {isEditing ? (
            <Input
              aria-label={`Default value for ${node.path}`}
              className="h-8 min-w-0 text-xs"
              disabled={editingField.type === "json" || hasChildren}
              onChange={(event) =>
                onEditChange({ defaultValue: event.target.value })
              }
              placeholder="—"
              type="text"
              value={editingField.defaultValue}
            />
          ) : (
            <span
              className="block truncate text-xs text-muted-foreground"
              title={field?.defaultValue || undefined}
            >
              {field?.defaultValue || "—"}
            </span>
          )}
        </div>

        <div className="flex items-center justify-end gap-1 px-3 py-2">
          {isEditing ? (
            <>
              <Button
                onClick={onCancelEdit}
                size="xs"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" />
                Cancel
              </Button>
              <Button
                onClick={onSaveEdit}
                size="xs"
                type="button"
              >
                <CheckIcon aria-hidden="true" />
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                aria-label={`Add attribute inside ${node.path}`}
                onClick={() => onAdd(node.path)}
                size="xs"
                type="button"
                variant="outline"
              >
                <Plus aria-hidden="true" />
                Add child
              </Button>
              {field && (
                <>
                  <Button
                    aria-label={`Edit ${node.path}`}
                    onClick={() => onStartEdit(field, node.key)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  {lockReason ? (
                    <LockedControl
                      control={
                        <Button
                          aria-describedby={lockReasonId}
                          aria-disabled="true"
                          aria-label={`Delete ${node.path}`}
                          className="cursor-not-allowed text-muted-foreground opacity-64"
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      }
                      reason={lockReason}
                    />
                  ) : (
                    <Button
                      aria-label={`Delete ${node.path}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => onDelete(field.value)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {lockReason && (
            <span className="sr-only" id={lockReasonId}>
              {lockReason}
            </span>
          )}
        </div>
      </div>

      {isCreateFormHere && createForm}

      {hasChildren && (
        <CollapsiblePanel>
          {node.children.map((child) => (
            <AttributeNode
              createForm={createForm}
              createFormParentPath={createFormParentPath}
              depth={depth + 1}
              editingField={editingField}
              isCreateFormOpen={isCreateFormOpen}
              itemKey={itemKey}
              key={child.path}
              node={child}
              onAdd={onAdd}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
              onEditChange={onEditChange}
              onRequiredChange={onRequiredChange}
              onSaveEdit={onSaveEdit}
              onStartEdit={onStartEdit}
            />
          ))}
        </CollapsiblePanel>
      )}
    </Collapsible>
  );
}

export function ExistingEventAttributeOutline({
  createForm,
  createFormParentPath,
  editingField,
  fields,
  isCreateFormOpen,
  itemKey,
  onAdd,
  onCancelEdit,
  onDelete,
  onEditChange,
  onRequiredChange,
  onSaveEdit,
  onStartEdit,
}: ExistingEventAttributeOutlineProps) {
  const tree = buildEventAttributeTree(fields);

  return (
    <div
      aria-label="Event attributes"
      className="overflow-x-auto rounded-lg border bg-background"
      role="tree"
    >
      {isCreateFormOpen && createFormParentPath === null && createForm}

      <div className={`${OUTLINE_COLUMNS} bg-muted/30 text-[11px] font-medium text-muted-foreground`}>
        <div className="px-3 py-1.5">Attribute</div>
        <div className="px-3 py-1.5">Type</div>
        <div className="px-3 py-1.5">Required</div>
        <div className="px-3 py-1.5">Example</div>
        <div className="px-3 py-1.5">Default</div>
        <div className="px-3 py-1.5 text-right">Actions</div>
      </div>

      {tree.children.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No attributes defined. Add one when this event needs additional
          data.
        </div>
      ) : (
        tree.children.map((node) => (
          <AttributeNode
            createForm={createForm}
            createFormParentPath={createFormParentPath}
            depth={0}
            editingField={editingField}
            isCreateFormOpen={isCreateFormOpen}
            itemKey={itemKey}
            key={node.path}
            node={node}
            onAdd={onAdd}
            onCancelEdit={onCancelEdit}
            onDelete={onDelete}
            onEditChange={onEditChange}
            onRequiredChange={onRequiredChange}
            onSaveEdit={onSaveEdit}
            onStartEdit={onStartEdit}
          />
        ))
      )}
    </div>
  );
}
