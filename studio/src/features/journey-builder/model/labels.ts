import type { CampaignNode } from "@/entities/journey/model/types";
import { CHANNEL_LABEL } from "./palette";

// JBD-FR-22: a node card names the step by its type and main setting, never by its node id.

export interface CardText {
  /** The step type, as the card's small caps line shows it. */
  kind: string;
  label: string;
  sub: string;
}

/** An event's display name from the catalog, or its saved name when the catalog lacks it. */
export type EventName = (name: string | undefined) => string | null;

const UNIT: Record<string, [string, string]> = {
  seconds: ["second", "seconds"],
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
};

export function limitText(value: unknown, unit: unknown): string {
  const count = Number(value);
  const names = UNIT[String(unit)] ?? [String(unit), String(unit)];
  return `${Number.isFinite(count) ? count : "?"} ${count === 1 ? names[0] : names[1]}`;
}

function groupCount(groups: unknown): number {
  return Array.isArray((groups as { groups?: unknown[] } | undefined)?.groups) ? (groups as { groups: unknown[] }).groups.length : 0;
}

function rules(count: number, noun: string): string {
  return count === 0 ? `No ${noun}s` : `${count} ${noun} group${count === 1 ? "" : "s"}`;
}

const WATCH_PATHS: Record<string, string> = {
  SuccessOrTimeoutPath: "on success or timeout",
  SuccessPath: "on success",
  TimeoutPath: "on timeout",
};

const CHECK_PATHS: Record<string, string> = {
  YesOrNoPath: "Yes and No",
  YesPath: "Yes only",
  NoPath: "No only",
  MultiBranchPath: "Named branches",
};

export function cardText(node: CampaignNode, eventName: EventName): CardText {
  const config = node.config;
  switch (node.type) {
    case "setup": {
      const event = eventName(config.triggerEventName);
      return { kind: "START", label: event ? `Start: ${event}` : "Start: pick an event", sub: rules(groupCount(config.filters), "filter") };
    }
    case "check": {
      const event = eventName(config.eventName);
      const multi = config.checkType === "MultiBranchPath";
      return {
        kind: multi ? "BRANCH BY EVENT" : "CHECK",
        label: event ? `Check: ${event}` : "Check: pick an event",
        sub: CHECK_PATHS[config.checkType] ?? "Yes and No",
      };
    }
    case "watch": {
      const limit = limitText(config.timeLimitValue, config.timeLimitUnit);
      if (config.watchType === "DelayPath") return { kind: "WAIT", label: `Wait ${limit}`, sub: "Then go on" };
      const event = eventName(config.eventName);
      return {
        kind: "WAIT FOR EVENT",
        label: event ? `Wait for ${event}` : "Wait for: pick an event",
        sub: `${limit} · ${WATCH_PATHS[config.watchType] ?? WATCH_PATHS.SuccessOrTimeoutPath}`,
      };
    }
    case "segment":
      return { kind: "CONDITION SPLIT", label: "Condition split", sub: rules(groupCount(config.conditions), "condition") };
    case "engagement": {
      const channel = CHANNEL_LABEL[node.subType] ?? node.subType;
      const title = String(config.title || config.subject || "").trim();
      return { kind: channel.toUpperCase(), label: title ? `${channel} “${title}”` : channel, sub: "Message" };
    }
    case "end": {
      const description = String(config.description ?? "");
      return { kind: "END", label: "End", sub: description === "Journey ends" ? "" : description };
    }
  }
}
