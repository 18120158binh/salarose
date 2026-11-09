// The trigger kinds, condition types, and options that the runtime evaluates (JBD-FR-31). The
// palette, the condition editors, and the validator read it, so no builder offers a control that
// the runtime ignores.

// business_event stays out of the registry until customer decision reads business-event matches.
type RegistryTrigger = "event" | "segment_entry";
export type TriggerKind = RegistryTrigger | "business_event";
export type ConditionType = "event_property" | "profile_property" | "behavior" | "segment_membership";
export type RuntimeOption =
  | "segment_mode_event_filters"
  | "size_from_tracked_members"
  | "size_with_imported_members"
  | "include_current_members";

export type RuntimeEntry = { online: boolean } & (
  | { type: "trigger"; name: RegistryTrigger }
  | { type: "condition"; name: ConditionType }
  | { type: "option"; name: RuntimeOption }
);

export type RuntimeRegistry = readonly RuntimeEntry[];

// The start set, then the six entries in the order they come online, each once its runtime change
// runs on the cluster.
export const RUNTIME_REGISTRY: RuntimeRegistry = [
  { type: "trigger", name: "event", online: true },
  { type: "condition", name: "event_property", online: true },
  { type: "condition", name: "profile_property", online: true },
  { type: "condition", name: "behavior", online: true },
  { type: "condition", name: "segment_membership", online: false },
  { type: "trigger", name: "segment_entry", online: false },
  { type: "option", name: "segment_mode_event_filters", online: false },
  { type: "option", name: "size_from_tracked_members", online: false },
  { type: "option", name: "size_with_imported_members", online: false },
  { type: "option", name: "include_current_members", online: false },
];

// No timer evaluates INACTION, so it never matches. A saved condition may still hold it.
const HIDDEN_MEASURES = ["INACTION"];

function online(registry: RuntimeRegistry, type: RuntimeEntry["type"], name: string): boolean {
  return registry.some((entry) => entry.online && entry.type === type && entry.name === name);
}

export function offersTrigger(registry: RuntimeRegistry, kind: TriggerKind): boolean {
  return online(registry, "trigger", kind);
}

export function offersConditionType(registry: RuntimeRegistry, type: ConditionType): boolean {
  return online(registry, "condition", type);
}

export function hasOption(registry: RuntimeRegistry, option: RuntimeOption): boolean {
  return online(registry, "option", option);
}

/** Whether a new behavior condition may offer the measure, whatever the registry holds. */
export function offersMeasure(measure: string): boolean {
  return !HIDDEN_MEASURES.includes(measure);
}
