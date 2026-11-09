import type { EventKind } from "shared/lib/eventCatalog";

// The kind while the admin fills a form. Business is picked before its item key, so only here
// can a business event lack one.
export type EventKindDraft = { kind: "person" } | { kind: "business"; itemKey: string | null };

export function draftForKind(kind: EventKind["kind"]): EventKindDraft {
  switch (kind) {
    case "person":
      return { kind: "person" };
    case "business":
      return { kind: "business", itemKey: null };
    default: {
      const unknownKind: never = kind;
      throw new Error(`Unknown event kind ${String(unknownKind)}`);
    }
  }
}

// The kind to send, or null while a business event has no item key.
export function completeEventKind(draft: EventKindDraft): EventKind | null {
  switch (draft.kind) {
    case "person":
      return draft;
    case "business":
      return draft.itemKey === null ? null : { kind: "business", itemKey: draft.itemKey };
    default: {
      const unknownKind: never = draft;
      throw new Error(`Unknown event kind ${JSON.stringify(unknownKind)}`);
    }
  }
}

// Clears an item key that is no longer one of the attribute paths, such as after a rename.
export function keepAvailableItemKey(draft: EventKindDraft, paths: readonly string[]): EventKindDraft {
  return draft.kind === "business" && draft.itemKey !== null && !paths.includes(draft.itemKey)
    ? { kind: "business", itemKey: null }
    : draft;
}

export function eventItemKey(eventKind: EventKind): string | null {
  switch (eventKind.kind) {
    case "person":
      return null;
    case "business":
      return eventKind.itemKey;
    default: {
      const unknownKind: never = eventKind;
      throw new Error(`Unknown event kind ${JSON.stringify(unknownKind)}`);
    }
  }
}
