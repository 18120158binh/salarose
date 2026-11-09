import {
  appendEventAttributeChild,
  buildEventAttributeTree,
  normalizeEventAttributePath,
  type EventAttributeTreeNode,
} from "./eventAttributeTree";

export interface EditableEventAttribute {
  id: string;
  value: string;
  displayName: string;
  dataType: string;
  exampleValue: string;
}

export function eventAttributesToJson(
  attributes: EditableEventAttribute[],
): string {
  const tree = buildEventAttributeTree(attributes);
  const payload = Object.fromEntries(
    tree.children.map((node) => [node.key, treeNodeToValue(node)]),
  );
  return JSON.stringify(payload, null, 2);
}

export function jsonToEventAttributes(
  json: string,
  existingAttributes: EditableEventAttribute[],
  createId: () => string,
): EditableEventAttribute[] {
  const payload: unknown = JSON.parse(json);
  if (!isObject(payload)) {
    throw new Error("The payload must be a JSON object.");
  }

  const existingByPath = new Map(
    existingAttributes.map((attribute) => [
      normalizeEventAttributePath(attribute.value),
      attribute,
    ]),
  );
  const attributes: EditableEventAttribute[] = [];
  const paths = new Set<string>();

  const visit = (object: Record<string, unknown>, parentPath = "") => {
    Object.entries(object).forEach(([key, value]) => {
      const path = payloadAttributePath(parentPath, key);
      if (paths.has(path)) throw new Error(`Two keys give the path "${path}".`);
      paths.add(path);
      const existing = existingByPath.get(path);
      const objectValue = isObject(value);

      attributes.push({
        id: existing?.id ?? createId(),
        value: path,
        displayName: existing
          ? existing.displayName
          : displayNameForKey(key),
        dataType: inferDataType(value, existing?.dataType),
        exampleValue: objectValue ? "" : exampleValueFor(value),
      });

      if (objectValue) {
        visit(value, path);
      }
    });
  };

  visit(payload);
  return attributes;
}

// A key becomes one attribute key, so a dot or an empty key would land the value at a path the
// admin did not write.
function payloadAttributePath(parentPath: string, key: string): string {
  const leaf = key.trim();
  if (!leaf) {
    throw new Error(parentPath ? `The payload has an empty key inside ${parentPath}.` : "The payload has an empty key.");
  }
  if (leaf.includes(".")) {
    throw new Error(`The key "${leaf}" contains a dot. Nest it as an object instead.`);
  }
  return appendEventAttributeChild(parentPath, leaf);
}

function treeNodeToValue(
  node: EventAttributeTreeNode<EditableEventAttribute>,
): unknown {
  if (node.children.length > 0) {
    return Object.fromEntries(
      node.children.map((child) => [child.key, treeNodeToValue(child)]),
    );
  }

  const attribute = node.attribute;
  if (!attribute) return {};

  const example = attribute.exampleValue.trim();
  switch (attribute.dataType.toLowerCase()) {
    case "number": {
      const number = Number(example);
      return example && Number.isFinite(number) ? number : 0;
    }
    case "boolean":
      return example.toLowerCase() === "true";
    case "json":
      return parseJsonExample(example);
    default:
      return attribute.exampleValue;
  }
}

function inferDataType(value: unknown, existingType?: string): string {
  if (isObject(value) || Array.isArray(value)) return "json";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && existingType === "datetime") {
    return "datetime";
  }
  return existingType && value === null ? existingType : "string";
}

function exampleValueFor(value: unknown): string {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function parseJsonExample(example: string): unknown {
  if (!example) return {};
  try {
    return JSON.parse(example);
  } catch {
    return {};
  }
}

function displayNameForKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
