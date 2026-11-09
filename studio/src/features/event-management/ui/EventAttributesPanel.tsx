"use client";

import React, { useState } from "react";
import type { UserEventFieldDef } from "@/app/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  appendEventAttributeChild,
  normalizeEventAttributePath,
  renameEventAttribute,
} from "@/features/event-management/model/eventAttributeTree";
import { EventAttributeCreateForm } from "@/features/event-management/ui/EventAttributeCreateForm";
import {
  ExistingEventAttributeOutline,
  type ExistingEventAttributeEdit,
} from "@/features/event-management/ui/ExistingEventAttributeOutline";
import { callServerAction } from "@/shared/lib/serverAction";
import {
  createUserEventFieldAction,
  deleteUserEventFieldAction,
  setUserEventFieldRequiredAction,
  updateUserEventFieldAction,
} from "@/app/actions";
import { AlertCircle, Plus } from "lucide-react";

interface EventAttributesPanelProps {
  eventId: string;
  fields: UserEventFieldDef[];
  itemKey: string | null;
  // Reads the event's attributes again after a change.
  onReload: () => Promise<void>;
  onRequiredChanged: (fieldPath: string, required: boolean) => void;
}

interface NewAttribute {
  parentPath: string | null;
  key: string;
  displayName: string;
  dataType: string;
  example: string;
}

// The attributes of one expanded event: the outline, the add form, and the edit row.
export function EventAttributesPanel({ eventId, fields, itemKey, onReload, onRequiredChanged }: EventAttributesPanelProps) {
  const [newAttribute, setNewAttribute] = useState<NewAttribute | null>(null);
  const [editingField, setEditingField] = useState<ExistingEventAttributeEdit | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const openAttributeForm = (parentPath: string | null) => {
    setNewAttribute({
      parentPath: parentPath ? normalizeEventAttributePath(parentPath) : null,
      key: "",
      displayName: "",
      dataType: "string",
      example: "",
    });
  };

  const changeNewAttribute = (changes: Partial<NewAttribute>) => {
    setNewAttribute((current) => (current ? { ...current, ...changes } : current));
  };

  const handleCreateField = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    if (!newAttribute) return;
    setIsSubmitting(true);
    setError("");
    try {
      const result = await callServerAction(() =>
        createUserEventFieldAction(
          eventId,
          appendEventAttributeChild(newAttribute.parentPath ?? "", newAttribute.key),
          newAttribute.displayName,
          newAttribute.dataType,
          newAttribute.example,
        ),
      );
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      setNewAttribute(null);
      await onReload();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequiredChange = async (fieldPath: string, required: boolean) => {
    setError("");
    const result = await callServerAction(() => setUserEventFieldRequiredAction(eventId, fieldPath, required));
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    onRequiredChanged(fieldPath, required);
  };

  const handleDeleteField = async (fieldPath: string) => {
    if (!confirm(`Are you sure you want to delete the attribute '${normalizeEventAttributePath(fieldPath)}'?`)) return;
    setError("");
    const result = await callServerAction(() => deleteUserEventFieldAction(fieldPath, eventId));
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    await onReload();
  };

  const handleSaveField = async () => {
    if (!editingField) return;
    let updatedPath: string;
    try {
      const renamed = renameEventAttribute(fields, editingField.originalPath, editingField.path);
      updatedPath = renamed[fields.findIndex((field) => field.value === editingField.originalPath)].value;
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
      return;
    }

    setError("");
    const result = await callServerAction(() =>
      updateUserEventFieldAction(eventId, editingField.originalPath, {
        fieldPath: updatedPath,
        displayName: editingField.name,
        dataType: editingField.type,
        exampleValue: editingField.example,
        defaultValue: editingField.defaultValue,
      }),
    );
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    setEditingField(null);
    await onReload();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold tracking-tight">Event Attributes</h4>
        <Button aria-label="Add Attribute" onClick={() => openAttributeForm(null)} size="xs" type="button" variant="outline">
          <Plus aria-hidden="true" />
          Add attribute
        </Button>
      </div>
      {error && (
        <Alert variant="error">
          <AlertCircle aria-hidden="true" />
          <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
        </Alert>
      )}
      <ExistingEventAttributeOutline
        createForm={
          newAttribute && (
            <EventAttributeCreateForm
              dataType={newAttribute.dataType}
              displayName={newAttribute.displayName}
              eventId={eventId}
              exampleValue={newAttribute.example}
              fieldKey={newAttribute.key}
              isSubmitting={isSubmitting}
              onCancel={() => setNewAttribute(null)}
              onDataTypeChange={(dataType) => changeNewAttribute({ dataType })}
              onDisplayNameChange={(displayName) => changeNewAttribute({ displayName })}
              onExampleValueChange={(example) => changeNewAttribute({ example })}
              onFieldKeyChange={(key) => changeNewAttribute({ key })}
              onSubmit={(formEvent) => void handleCreateField(formEvent)}
              parentPath={newAttribute.parentPath}
            />
          )
        }
        createFormParentPath={newAttribute?.parentPath ?? null}
        editingField={editingField}
        fields={fields}
        isCreateFormOpen={newAttribute !== null}
        itemKey={itemKey}
        onAdd={openAttributeForm}
        onCancelEdit={() => setEditingField(null)}
        onDelete={(fieldPath) => void handleDeleteField(fieldPath)}
        onEditChange={(changes) => setEditingField((current) => (current ? { ...current, ...changes } : null))}
        onRequiredChange={(fieldPath, required) => void handleRequiredChange(fieldPath, required)}
        onSaveEdit={() => void handleSaveField()}
        onStartEdit={(field, leafKey) =>
          setEditingField({
            eventId,
            originalPath: field.value,
            path: leafKey,
            name: field.label,
            type: field.dataType || "string",
            example: field.exampleValue || "",
            defaultValue: field.defaultValue || "",
          })
        }
      />
    </div>
  );
}
