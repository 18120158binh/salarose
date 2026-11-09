"use client";

import { useRef, useState } from "react";
import {
  createUniqueEventAttributePath,
  isEventAttributeInSubtree,
  normalizeEventAttributePath,
  renameEventAttribute,
} from "../model/eventAttributeTree";
import { eventAttributesToJson, jsonToEventAttributes, type EditableEventAttribute } from "../model/eventAttributePayload";

export type CreationMode = "manual" | "json";

function payloadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Invalid JSON payload.";
  return error instanceof SyntaxError ? `Invalid JSON: ${message}` : message;
}

// The attribute tree of a new event, edited in the tree editor or as a sample JSON payload. The two
// modes stay in sync: a valid payload replaces the tree, and an invalid one keeps it (CAT-FR-03).
export function useEventAttributeDraft() {
  const pendingIdSequence = useRef(0);
  const [creationMode, setCreationMode] = useState<CreationMode>("manual");
  const [attributes, setAttributes] = useState<EditableEventAttribute[]>([]);
  const [jsonPayload, setJsonPayload] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [treeError, setTreeError] = useState("");

  const createPendingId = () => {
    pendingIdSequence.current += 1;
    return `pending-field-${pendingIdSequence.current}`;
  };

  const applyJsonPayload = (payload: string): boolean => {
    try {
      setAttributes(jsonToEventAttributes(payload, attributes, createPendingId));
      setJsonError("");
      return true;
    } catch (error) {
      setJsonError(payloadErrorMessage(error));
      return false;
    }
  };

  return {
    attributes,
    creationMode,
    jsonPayload,
    jsonError,
    treeError,
    changeMode(nextMode: string | null) {
      if (nextMode === "json") {
        setJsonPayload(eventAttributesToJson(attributes));
        setJsonError("");
        setCreationMode("json");
        return;
      }
      if (nextMode === "manual" && applyJsonPayload(jsonPayload)) setCreationMode("manual");
    },
    typePayload(payload: string) {
      setJsonPayload(payload);
      applyJsonPayload(payload);
    },
    add(parentPath = "") {
      const parent = normalizeEventAttributePath(parentPath);
      const attribute: EditableEventAttribute = {
        id: createPendingId(),
        value: createUniqueEventAttributePath(attributes, parentPath),
        displayName: "",
        dataType: "string",
        exampleValue: "",
      };
      setAttributes((current) => [
        ...current.map((field) =>
          parent && normalizeEventAttributePath(field.value) === parent ? { ...field, dataType: "json", exampleValue: "" } : field,
        ),
        attribute,
      ]);
    },
    change(attributeId: string, changes: Partial<EditableEventAttribute>) {
      setAttributes((current) => current.map((field) => (field.id === attributeId ? { ...field, ...changes } : field)));
    },
    rename(originalPath: string, nextKey: string) {
      try {
        setAttributes(renameEventAttribute(attributes, originalPath, nextKey));
        setTreeError("");
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    remove(subtreeRootPath: string) {
      setAttributes((current) => current.filter((field) => !isEventAttributeInSubtree(field.value, subtreeRootPath)));
    },
    /** The attributes to save, read from the payload in JSON mode, or null after showing its error. */
    toSave(): EditableEventAttribute[] | null {
      if (creationMode !== "json") return attributes;
      try {
        return jsonToEventAttributes(jsonPayload, attributes, createPendingId);
      } catch (error) {
        setJsonError(payloadErrorMessage(error));
        return null;
      }
    },
    reset() {
      setAttributes([]);
      setJsonPayload("");
      setJsonError("");
      setTreeError("");
      setCreationMode("manual");
    },
  };
}
