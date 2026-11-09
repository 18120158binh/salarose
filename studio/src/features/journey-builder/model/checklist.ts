import type { JourneyGraph } from "@/entities/journey/model/graphEdits";
import type { JourneyProblem } from "@/entities/journey/model/parseCampaign";
import type { CampaignNode } from "@/entities/journey/model/types";
import { CHANNEL_LABEL } from "./palette";
import { cardText, type EventName } from "./labels";

// JBD-FR-25, JBD-FR-44: the checklist is the validator's problems, grouped by step in tree order,
// plus one blocking item for each event the catalog lacks. Nothing here decides severity: the
// validator does, and the catalog rule is always blocking.

export interface ChecklistItem {
  severity: JourneyProblem["severity"];
  /** The field's name as the panel shows it, or null for the step itself. */
  field: string | null;
  message: string;
}

export interface ChecklistGroup {
  /** The step to go to, or null for a problem with no step. */
  nodeId: string | null;
  title: string;
  node: CampaignNode | null;
  items: ChecklistItem[];
}

export interface Checklist {
  blocks: number;
  warnings: number;
  groups: ChecklistGroup[];
  /** The catalog names of the events the journey uses that the catalog lacks. */
  missingEvents: string[];
  /** The display names of the events the journey uses that the catalog has. */
  knownEvents: string[];
}

const FIELD_LABEL: Record<string, string> = {
  triggerEventName: "Trigger",
  eventName: "Event",
  filters: "Filters",
  personFilters: "Who can enter",
  conditions: "Conditions",
  timeLimitValue: "Wait time",
  timeLimitUnit: "Wait time",
  branches: "Branches",
  action: "Message",
  label: "Name",
};

function fieldLabel(field: string): string | null {
  const key = field.split(/[.[]/)[0];
  if (key === "") return null;
  return FIELD_LABEL[key] ?? key;
}

function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
}

// Every string a node's config holds under a key that ends in "eventName", at any depth, so a
// behavior condition's event counts as well as a trigger's.
function eventNamesOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => eventNamesOf(item, found));
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (/eventName$/i.test(key) && typeof inner === "string" && inner.trim() !== "") found.add(inner);
      else eventNamesOf(inner, found);
    }
  }
  return found;
}

export function buildChecklist(
  problems: readonly JourneyProblem[],
  graph: JourneyGraph,
  catalog: ReadonlySet<string>,
  eventName: EventName,
): Checklist {
  const groups = new Map<string | null, ChecklistGroup>();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const groupOf = (nodeId: string | null): ChecklistGroup => {
    const existing = groups.get(nodeId);
    if (existing) return existing;
    const node = nodeId === null ? null : (nodes.get(nodeId) ?? null);
    const group = { nodeId: node ? nodeId : null, node, title: node ? cardText(node, eventName).label : "Journey", items: [] };
    groups.set(nodeId, group);
    return group;
  };

  for (const problem of problems) {
    groupOf(problem.nodeId ?? null).items.push({ severity: problem.severity, field: fieldLabel(problem.field), message: sentence(problem.message) });
  }

  const missing = new Set<string>();
  const known = new Set<string>();
  for (const node of graph.nodes) {
    for (const name of eventNamesOf(node.config)) {
      if (catalog.has(name)) {
        known.add(eventName(name) ?? name);
        continue;
      }
      missing.add(name);
      groupOf(node.id).items.push({
        severity: "blocking",
        field: "Event",
        message: `${name} is not in your events. Add this event to the catalog or pick another.`,
      });
    }
  }

  // Problems arrive in tree order, but a step with only a catalog problem joins at the end, so
  // order the groups by the steps' order on the canvas.
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const sorted = [...groups.values()].sort((a, b) => (order.get(a.nodeId ?? "") ?? -1) - (order.get(b.nodeId ?? "") ?? -1));
  for (const group of sorted) group.items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));

  const items = sorted.flatMap((group) => group.items);
  const blocks = items.filter((item) => item.severity === "blocking").length;
  return { blocks, warnings: items.length - blocks, groups: sorted, missingEvents: [...missing], knownEvents: [...known] };
}

/** The review dialog's plain summary of the journey, such as "Starts when someone does Added to cart. 7 steps. Sends 1 push and 1 SMS." */
export function journeySummary(graph: JourneyGraph, eventName: EventName): string {
  const setup = graph.nodes.find((node) => node.type === "setup");
  const trigger = eventName(setup?.config.triggerEventName);
  const start = trigger ? `Starts when someone does ${trigger}.` : "Has no trigger event yet.";
  const steps = graph.nodes.length;
  const sends = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type !== "engagement") continue;
    const channel = CHANNEL_LABEL[node.subType] ?? node.subType;
    sends.set(channel, (sends.get(channel) ?? 0) + 1);
  }
  const parts = [...sends].map(([channel, count]) => `${count} ${channel.toLowerCase() === "sms" ? "SMS" : channel.toLowerCase()}`);
  const send = parts.length === 0 ? "Sends no message." : `Sends ${parts.join(" and ")}.`;
  return `${start} ${steps} step${steps === 1 ? "" : "s"}. ${send}`;
}
