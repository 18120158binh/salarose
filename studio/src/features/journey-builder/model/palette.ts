import type { PaletteItem } from "@/entities/journey/model/graphEdits";
import { offersTrigger, type RuntimeRegistry } from "@/entities/journey/model/registry";

// The builder's palette, in the board's groups (JBD-FR-01). Messages offer Push and SMS only: the
// owner left the other channels out for now (2026-11-08).

export type PaletteGroup = "START" | "LOGIC" | "WAIT" | "MESSAGES" | "END";

export type PaletteKey =
  | "event-trigger"
  | "check"
  | "branch-by-event"
  | "condition-split"
  | "wait-for-event"
  | "wait-for-time"
  | "push"
  | "sms"
  | "end";

export interface PaletteEntry {
  key: PaletteKey;
  group: PaletteGroup;
  label: string;
  /** What the entry makes. The start step and End are not added from the palette. */
  item: PaletteItem | null;
}

export const MESSAGE_CHANNELS = ["push", "sms"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const CHANNEL_LABEL: Record<string, string> = {
  push: "Push",
  sms: "SMS",
  "web-push": "Web push",
  email: "Email",
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  webhook: "Webhook",
  zalo: "Zalo",
};

const ENTRIES: readonly PaletteEntry[] = [
  { key: "event-trigger", group: "START", label: "Event trigger", item: null },
  {
    key: "check",
    group: "LOGIC",
    label: "Check",
    item: { type: "check", subType: "check", label: "Check", defaultConfig: { checkType: "YesOrNoPath" } },
  },
  {
    key: "branch-by-event",
    group: "LOGIC",
    label: "Branch by event",
    item: { type: "check", subType: "check", label: "Branch by event", defaultConfig: { checkType: "MultiBranchPath" } },
  },
  {
    key: "condition-split",
    group: "LOGIC",
    label: "Condition split",
    item: { type: "segment", subType: "segment", label: "Condition split", defaultConfig: { checkType: "YesPath" } },
  },
  {
    key: "wait-for-event",
    group: "WAIT",
    label: "Wait for event",
    item: {
      type: "watch",
      subType: "watch",
      label: "Wait for event",
      defaultConfig: { watchType: "SuccessOrTimeoutPath", timeLimitValue: 1, timeLimitUnit: "hours" },
    },
  },
  {
    key: "wait-for-time",
    group: "WAIT",
    label: "Wait for time",
    item: {
      type: "watch",
      subType: "watch",
      label: "Wait for time",
      defaultConfig: { watchType: "DelayPath", timeLimitValue: 1, timeLimitUnit: "days" },
    },
  },
  {
    key: "push",
    group: "MESSAGES",
    label: "Push",
    item: { type: "engagement", subType: "push", label: "Push", defaultConfig: { title: "", body: "", url: "" } },
  },
  {
    key: "sms",
    group: "MESSAGES",
    label: "SMS",
    item: { type: "engagement", subType: "sms", label: "SMS", defaultConfig: { body: "" } },
  },
  { key: "end", group: "END", label: "End", item: null },
];

/** The entries the runtime registry lets the palette offer, narrowed by the search text. */
export function paletteEntries(registry: RuntimeRegistry, search: string): PaletteEntry[] {
  const query = search.trim().toLowerCase();
  return ENTRIES.filter((entry) => entry.key !== "event-trigger" || offersTrigger(registry, "event")).filter(
    (entry) => query === "" || entry.label.toLowerCase().includes(query),
  );
}

export const PALETTE_GROUPS: readonly PaletteGroup[] = ["START", "LOGIC", "WAIT", "MESSAGES", "END"];
