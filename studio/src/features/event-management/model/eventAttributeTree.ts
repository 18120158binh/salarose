export interface EventAttributeRecord {
  value: string;
  dataType?: string;
}

export interface EventAttributeTreeNode<T extends EventAttributeRecord> {
  key: string;
  path: string;
  attribute: T | null;
  children: EventAttributeTreeNode<T>[];
}

export interface EventAttributeTreeRow<T extends EventAttributeRecord> {
  node: EventAttributeTreeNode<T>;
  depth: number;
}

export function getEventAttributeSegments(value: string): string[] {
  return value
    .trim()
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function normalizeEventAttributePath(value: string): string {
  return getEventAttributeSegments(value).join(".");
}

export function getEventAttributeLeafKey(value: string): string {
  return getEventAttributeSegments(value).pop() ?? "";
}

export function appendEventAttributeChild(
  parentPath: string,
  childKey: string,
): string {
  const parentSegments = getEventAttributeSegments(parentPath);
  const childLeaf = getEventAttributeLeafKey(childKey);
  return normalizeEventAttributePath(
    [...parentSegments, childLeaf].filter(Boolean).join("."),
  );
}

export function replaceEventAttributeLeaf(
  attributePath: string,
  leafKey: string,
): string {
  const segments = getEventAttributeSegments(attributePath);
  const replacement = getEventAttributeLeafKey(leafKey);
  if (segments.length === 0 || !replacement) {
    return normalizeEventAttributePath(attributePath);
  }
  return normalizeEventAttributePath(
    [...segments.slice(0, -1), replacement].join("."),
  );
}

export function replaceEventAttributePathPrefix(
  attributePath: string,
  originalPrefix: string,
  replacementPrefix: string,
): string {
  const attributeSegments = getEventAttributeSegments(attributePath);
  const originalSegments = getEventAttributeSegments(originalPrefix);
  const replacementSegments = getEventAttributeSegments(replacementPrefix);
  const belongsToSubtree = originalSegments.every(
    (segment, index) => attributeSegments[index] === segment,
  );

  if (!belongsToSubtree || attributeSegments.length < originalSegments.length) {
    return normalizeEventAttributePath(attributePath);
  }

  return normalizeEventAttributePath([
    ...replacementSegments,
    ...attributeSegments.slice(originalSegments.length),
  ].join("."));
}

// Renames the attribute at a path to a new key, and moves its descendants with it. Throws when the
// key is empty or dotted, or when a sibling already has it, since two attributes would then share
// one path.
export function renameEventAttribute<T extends EventAttributeRecord>(
  attributes: T[],
  originalPath: string,
  nextKey: string,
): T[] {
  const key = nextKey.trim();
  if (!key) throw new Error("An attribute key cannot be empty.");
  if (key.includes(".")) {
    throw new Error(`The key "${key}" contains a dot. Add a child attribute instead.`);
  }
  const replacementPath = replaceEventAttributeLeaf(originalPath, key);
  if (replacementPath === normalizeEventAttributePath(originalPath)) return attributes;
  if (attributes.some((attribute) => isEventAttributeInSubtree(attribute.value, replacementPath))) {
    throw new Error(`An attribute with the path "${replacementPath}" already exists.`);
  }
  return attributes.map((attribute) => ({
    ...attribute,
    value: replaceEventAttributePathPrefix(attribute.value, originalPath, replacementPath),
  }));
}

export function isEventAttributeInSubtree(
  attributePath: string,
  subtreeRootPath: string,
): boolean {
  const attributeSegments = getEventAttributeSegments(attributePath);
  const rootSegments = getEventAttributeSegments(subtreeRootPath);
  return (
    attributeSegments.length >= rootSegments.length &&
    rootSegments.every((segment, index) => attributeSegments[index] === segment)
  );
}

export function createUniqueEventAttributePath(
  attributes: EventAttributeRecord[],
  parentPath = "",
  baseKey = "new_attribute",
): string {
  const existingPaths = new Set(
    attributes.map((attribute) =>
      normalizeEventAttributePath(attribute.value)),
  );
  let candidate = appendEventAttributeChild(parentPath, baseKey);
  let suffix = 2;

  while (existingPaths.has(candidate)) {
    candidate = appendEventAttributeChild(parentPath, `${baseKey}_${suffix}`);
    suffix += 1;
  }
  return candidate;
}

export function buildEventAttributeTree<T extends EventAttributeRecord>(
  attributes: T[],
): EventAttributeTreeNode<T> {
  const root: EventAttributeTreeNode<T> = {
    key: "",
    path: "",
    attribute: null,
    children: [],
  };

  for (const attribute of attributes) {
    const segments = getEventAttributeSegments(attribute.value);
    let current = root;

    segments.forEach((segment, index) => {
      let child = current.children.find((node) => node.key === segment);
      if (!child) {
        child = {
          key: segment,
          path: normalizeEventAttributePath(
            segments.slice(0, index + 1).join("."),
          ),
          attribute: null,
          children: [],
        };
        current.children.push(child);
      }

      if (index === segments.length - 1) {
        child.attribute = attribute;
      }
      current = child;
    });
  }

  sortTreeChildren(root);
  return root;
}

export function flattenEventAttributeTree<T extends EventAttributeRecord>(
  root: EventAttributeTreeNode<T>,
): EventAttributeTreeRow<T>[] {
  const rows: EventAttributeTreeRow<T>[] = [];

  const visit = (nodes: EventAttributeTreeNode<T>[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      visit(node.children, depth + 1);
    }
  };

  visit(root.children, 0);
  return rows;
}

export function isJsonAttribute(
  attribute: EventAttributeRecord | null,
): boolean {
  return attribute?.dataType?.toLowerCase() === "json";
}

function sortTreeChildren<T extends EventAttributeRecord>(
  node: EventAttributeTreeNode<T>,
): void {
  node.children.sort((left, right) =>
    left.key.localeCompare(right.key, undefined, { numeric: true }),
  );
  node.children.forEach(sortTreeChildren);
}
