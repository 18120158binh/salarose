"use client";

import { useEffect, type ReactNode } from "react";
import { ClockIcon, DiamondIcon, FlagIcon, GitForkIcon, MessageSquareIcon, SplitIcon, XIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stepsBelow, type JourneyGraph } from "@/entities/journey/model/graphEdits";
import { NO_EDGE, type CampaignNode } from "@/entities/journey/model/types";
import { getSubtreeNodeIds } from "@/entities/journey/model/utils";
import { cn } from "@/lib/utils";
import { cardText, limitText, type EventName } from "../model/labels";
import { CHANNEL_LABEL, MESSAGE_CHANNELS, type PaletteKey } from "../model/palette";
import type { CatalogEvent } from "./JourneyBuilder";

export interface Confirm {
  title: string;
  description: string;
  action: string;
  run: () => void;
}

type Config = CampaignNode["config"];

const ICONS: Record<PaletteKey, LucideIcon> = {
  "event-trigger": ZapIcon,
  check: DiamondIcon,
  "branch-by-event": GitForkIcon,
  "condition-split": SplitIcon,
  "wait-for-event": ZapIcon,
  "wait-for-time": ClockIcon,
  push: MessageSquareIcon,
  sms: MessageSquareIcon,
  end: FlagIcon,
};

function keyOf(node: CampaignNode): PaletteKey {
  switch (node.type) {
    case "setup":
      return "event-trigger";
    case "check":
      return node.config.checkType === "MultiBranchPath" ? "branch-by-event" : "check";
    case "segment":
      return "condition-split";
    case "watch":
      return node.config.watchType === "DelayPath" ? "wait-for-time" : "wait-for-event";
    case "engagement":
      return node.subType === "sms" ? "sms" : "push";
    case "end":
      return "end";
  }
}

/** The tile icon of a palette entry or a step. Start is teal, messages are blue, the rest neutral. */
export function StepIcon({ kind, node }: { kind?: PaletteKey; node?: CampaignNode }) {
  const key = kind ?? (node ? keyOf(node) : "end");
  const Icon = ICONS[key];
  const tone =
    key === "event-trigger" && node?.type !== "watch"
      ? "bg-primary/10 text-primary"
      : key === "push" || key === "sms"
        ? "bg-info/10 text-info"
        : "bg-secondary text-secondary-foreground";
  return (
    <span className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-md", tone)}>
      <Icon aria-hidden className="size-3" />
    </span>
  );
}

export interface StepPanelProps {
  node: CampaignNode;
  graph: JourneyGraph;
  events: CatalogEvent[];
  eventName: EventName;
  onConfigure: (config: Config) => void;
  onChannel: (channel: CampaignNode["subType"]) => void;
  onRemove: () => void;
  onClose: () => void;
  onConfirm: (confirm: Confirm) => void;
}

// JBD-FR-10: each step type opens its own panel. Edits apply as they happen, with no Apply button.
export function StepPanel({ node, graph, events, eventName, onConfigure, onChannel, onRemove, onClose, onConfirm }: StepPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = cardText(node, eventName);
  const set = (field: string, value: unknown) => onConfigure({ ...node.config, [field]: value });
  const order = [...getSubtreeNodeIds(graph.nodes.find((n) => n.type === "setup")?.id ?? "", graph.connections)];
  const below = stepsBelow(graph, node.id);

  return (
    <aside aria-label="Step settings" className="w-[360px] shrink-0 overflow-y-auto border-border border-s bg-card">
      <div className="flex items-start gap-2.5 px-4.5 pt-4 pb-2">
        <StepIcon node={node} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[10.5px] text-muted-foreground tracking-wider">{text.kind}</div>
          <h2 className="truncate font-heading font-semibold text-[15px]">{text.label}</h2>
        </div>
        <span className="font-heading text-muted-foreground text-xs tabular-nums">
          Step {order.indexOf(node.id) + 1} of {order.length}
        </span>
        <Button aria-label="Close panel (Esc)" onClick={onClose} size="icon-sm" title="Close (Esc)" variant="outline">
          <XIcon aria-hidden />
        </Button>
      </div>
      {node.type !== "end" && <p className="px-4.5 pb-3 text-muted-foreground text-xs">Changes save as you type. There is no Apply button.</p>}

      {node.type === "setup" && (
        <>
          <Section hint="The journey starts when someone does this event." title="Trigger">
            <EventPicker events={events} label="Trigger event" onChange={(name) => set("triggerEventName", name)} value={node.config.triggerEventName} />
          </Section>
          <Rules groups={node.config.filters} hint="Which events count. All of these must hold." title="Filters" />
          <Rules groups={node.config.conditions} hint="Tests on the person. All of these must hold." title="Who can enter" />
          <Section>
            <p className="text-muted-foreground text-xs">The start step can’t be removed.</p>
          </Section>
        </>
      )}

      {node.type === "watch" && node.config.watchType !== "DelayPath" && (
        <>
          <Section hint="People wait here until they do this event, or until time runs out." title="Event">
            <EventPicker events={events} label="Event to wait for" onChange={(name) => set("eventName", name)} value={node.config.eventName} />
          </Section>
          <Rules groups={node.config.filters} hint="Which events count. All of these must hold." title="Filters" />
          <Section title="Time limit">
            <Limit config={node.config} onConfigure={onConfigure} />
          </Section>
          <Section title="Branches">
            <Segmented
              label="Branches"
              onChange={(value) => set("watchType", value)}
              options={[
                ["SuccessPath", "On success"],
                ["TimeoutPath", "On timeout"],
                ["SuccessOrTimeoutPath", "Both"],
              ]}
              value={node.config.watchType ?? "SuccessOrTimeoutPath"}
            />
            <p className="mt-1.5 text-muted-foreground text-xs">
              On success: they did it in time. On timeout: they didn’t. Removing a branch asks first and names its steps.
            </p>
          </Section>
          <Remove below={below} branching onRemove={onRemove} />
        </>
      )}

      {node.type === "watch" && node.config.watchType === "DelayPath" && (
        <>
          <Section hint="People wait this long, then go on to the next step." title="Duration">
            <Limit config={node.config} onConfigure={onConfigure} />
          </Section>
          <Section hint="One path. Everyone goes on after the wait." title="Path" />
          <Remove below={below} onRemove={onRemove} />
        </>
      )}

      {node.type === "check" && (
        <>
          <Section title="Trigger">
            <EventPicker events={events} label="Check event" onChange={(name) => set("eventName", name)} value={node.config.eventName} />
            <p className="mt-2 text-muted-foreground text-xs">
              People wait at this step until they do {eventName(node.config.eventName) ?? "the event"}. Then they go to Yes if the conditions
              hold, and to No if they don’t. Someone who never does it stays here.
            </p>
          </Section>
          <Rules groups={node.config.filters} hint="Which events count. All of these must hold." title="Filters" />
          <Rules groups={node.config.conditions} hint="Tests on the person. All of these must hold." title="Conditions" />
          <Section title="Branches">
            <Segmented
              label="Branches"
              onChange={(value) => set("checkType", value)}
              options={[
                ["YesPath", "Yes only"],
                ["NoPath", "No only"],
                ["YesOrNoPath", "Yes and No"],
                ["MultiBranchPath", "Named branches"],
              ]}
              value={node.config.checkType ?? "YesOrNoPath"}
            />
            <p className="mt-1.5 text-muted-foreground text-xs">Removing a branch with steps on it asks first.</p>
          </Section>
          <Remove below={below} branching onRemove={onRemove} />
        </>
      )}

      {node.type === "segment" && (
        <SplitPanel below={below} graph={graph} node={node} onConfigure={onConfigure} onConfirm={onConfirm} onRemove={onRemove} />
      )}

      {node.type === "engagement" && <MessagePanel graph={graph} node={node} onChannel={onChannel} onConfigure={onConfigure} onRemove={onRemove} />}

      {node.type === "end" && (
        <Section>
          <p className="text-sm">The journey ends here for this path.</p>
          <p className="mt-1 text-muted-foreground text-xs">An end step has no settings. To go on, add a step on the + above it.</p>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, hint, children }: { title?: string; hint?: string; children?: ReactNode }) {
  return (
    <section className="border-border border-t px-4.5 py-3.5">
      {title && <h3 className="mb-0.5 font-heading font-semibold text-[13.5px]">{title}</h3>}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {children}
    </section>
  );
}

const FIELD = "mt-1.5 w-full rounded-control border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function EventPicker({ events, value, label, onChange }: { events: CatalogEvent[]; value: string | undefined; label: string; onChange: (name: string) => void }) {
  const known = events.some((event) => event.name === value);
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select className={FIELD} onChange={(event) => onChange(event.target.value)} value={value ?? ""}>
        <option disabled value="">
          {events.length === 0 ? "The catalog has no events" : "Pick an event"}
        </option>
        {value && !known && <option value={value}>{value} (not in the catalog)</option>}
        {events.map((event) => (
          <option key={event.name} value={event.name}>
            {event.label} · {event.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const UNITS = ["seconds", "minutes", "hours", "days"] as const;

function Limit({ config, onConfigure }: { config: Config; onConfigure: (config: Config) => void }) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-2.5">
      <label className="block">
        <span className="font-semibold text-xs">Number</span>
        <input
          className={cn(FIELD, "font-heading tabular-nums")}
          min={1}
          onChange={(event) => onConfigure({ ...config, timeLimitValue: Number(event.target.value) })}
          type="number"
          value={config.timeLimitValue ?? ""}
        />
      </label>
      <label className="block">
        <span className="font-semibold text-xs">Unit</span>
        <select className={FIELD} onChange={(event) => onConfigure({ ...config, timeLimitUnit: event.target.value })} value={config.timeLimitUnit ?? "minutes"}>
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Segmented({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string; onChange: (value: string) => void }) {
  return (
    <div aria-label={label} className="mt-1.5 flex flex-wrap overflow-hidden rounded-control border border-input bg-background" role="group">
      {options.map(([key, text]) => (
        <button
          aria-pressed={key === value}
          className={cn(
            "flex-auto border-border border-s px-2.5 py-1.5 text-xs first:border-s-0 focus-visible:outline-2 focus-visible:outline-ring",
            key === value ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground",
          )}
          key={key}
          onClick={() => key !== value && onChange(key)}
          type="button"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

interface Rule {
  type?: string;
  field?: string;
  op?: string;
  value?: unknown;
  event?: string;
  measure?: string;
  attribute?: string;
  window?: { value?: number; unit?: string };
}

function ruleText(rule: Rule): [string, string] {
  if (rule.type === "behavior") {
    const window = rule.window ? limitText(rule.window.value, String(rule.window.unit ?? "").toLowerCase()) : "";
    const what = rule.attribute ? `${rule.measure} of ${rule.attribute} for` : rule.measure;
    return ["Behavior", `${what} ${rule.event} ${rule.op} ${rule.value} in the last ${window}`];
  }
  const value = Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "");
  return [rule.type === "profile_property" ? "Profile" : rule.type === "segment_membership" ? "Segment" : "Event field", `${rule.field} ${rule.op} ${value}`];
}

// The rule groups read-only. Editing filters and conditions ships with the condition editor.
function Rules({ title, hint, groups }: { title: string; hint: string; groups: unknown }) {
  const list = ((groups as { groups?: { conditions?: Rule[] }[] } | undefined)?.groups ?? []).map((group) => group.conditions ?? []);
  return (
    <Section hint={list.length === 0 ? `None. ${hint.split(".")[0]}: everything counts.` : hint} title={title}>
      {list.map((rules, index) => (
        <div className="mt-2 rounded-tile border border-border bg-background p-2.5" key={index}>
          <div className="font-semibold text-[10.5px] text-muted-foreground tracking-wide">ANY OF</div>
          {rules.length === 0 && <p className="mt-1.5 font-semibold text-destructive text-xs">This group is empty. Add a filter or remove the group.</p>}
          {rules.map((rule, row) => {
            const [tag, sentence] = ruleText(rule);
            return (
              <p className="mt-1.5 text-xs" key={row}>
                <span className="me-1.5 rounded-sm bg-secondary px-1.5 py-0.5 font-semibold text-[10.5px]">{tag}</span>
                {sentence}
              </p>
            );
          })}
        </div>
      ))}
      <p className="mt-2 text-muted-foreground text-xs">Editing filters and conditions is not available here yet.</p>
    </Section>
  );
}

function Remove({ below, branching = false, onRemove }: { below: number; branching?: boolean; onRemove: () => void }) {
  return (
    <Section>
      <button className="font-semibold text-primary text-xs" onClick={onRemove} type="button">
        Remove step
      </button>
      <p className="text-muted-foreground text-xs">
        {branching ? `Removes this step and the ${below} below it. You'll be asked first.` : "Removes this step. The step below it moves up."}
      </p>
    </Section>
  );
}

function SplitPanel({ node, graph, below, onConfigure, onRemove, onConfirm }: { node: CampaignNode; graph: JourneyGraph; below: number; onConfigure: (config: Config) => void; onRemove: () => void; onConfirm: (confirm: Confirm) => void }) {
  const noChild = graph.connections.find((c) => c.from === node.id && c.type === NO_EDGE)?.to;
  const noSteps = noChild ? getSubtreeNodeIds(noChild, graph.connections).size : 0;
  return (
    <>
      <Rules groups={node.config.conditions} hint="Tests on the person, with at least one behavior. People move on as soon as these hold, even later." title="Conditions" />
      <Section hint="Yes only. People wait here until the conditions hold. Nobody takes a No path." title="Path">
        {noChild && (
          <div className="mt-2 flex flex-col gap-2">
            <p className="font-semibold text-warning text-xs">
              No branch from an older version: people never take this branch. Its {noSteps} steps never run.
            </p>
            <Button
              className="w-fit"
              onClick={() =>
                onConfirm({
                  title: "Remove the No branch?",
                  description: `This removes the No branch and its ${noSteps} steps.`,
                  action: "Remove branch",
                  run: () => onConfigure({ ...node.config, checkType: "YesPath" }),
                })
              }
              size="sm"
              variant="outline"
            >
              Remove branch
            </Button>
          </div>
        )}
      </Section>
      <Remove below={below} branching onRemove={onRemove} />
    </>
  );
}

function MessagePanel({ node, graph, onConfigure, onChannel, onRemove }: { node: CampaignNode; graph: JourneyGraph; onConfigure: (config: Config) => void; onChannel: (channel: CampaignNode["subType"]) => void; onRemove: () => void }) {
  const channel = node.subType;
  const isSms = channel === "sms";
  const channels: string[] = MESSAGE_CHANNELS.includes(channel as (typeof MESSAGE_CHANNELS)[number]) ? [...MESSAGE_CHANNELS] : [...MESSAGE_CHANNELS, channel];
  const set = (field: string) => (event: { target: { value: string } }) => onConfigure({ ...node.config, [field]: event.target.value });
  const next = graph.connections.find((c) => c.from === node.id)?.to;
  const nextNode = graph.nodes.find((n) => n.id === next);
  return (
    <>
      <Section title="Channel">
        <div aria-label="Channel" className="mt-1.5 grid grid-cols-4 gap-1" role="group">
          {channels.map((option) => (
            <button
              aria-pressed={option === channel}
              className={cn(
                "rounded-md border px-1 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring",
                option === channel ? "border-primary/40 bg-primary/10 font-semibold text-primary" : "border-border bg-background text-muted-foreground",
              )}
              key={option}
              onClick={() => option !== channel && onChannel(option as CampaignNode["subType"])}
              type="button"
            >
              {CHANNEL_LABEL[option] ?? option}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-muted-foreground text-xs">
          Switching keeps the text both channels share. Studio sends to the contact details in each customer’s profile.
        </p>
      </Section>
      <Section title="Content">
        {!isSms && (
          <label className="mt-1 block">
            <span className="font-semibold text-xs">Title</span>
            <input className={FIELD} onChange={set("title")} type="text" value={node.config.title ?? ""} />
          </label>
        )}
        <label className="mt-2.5 block">
          <span className="font-semibold text-xs">Message</span>
          <textarea className={FIELD} onChange={set("body")} rows={3} value={node.config.body ?? ""} />
        </label>
        {!isSms && (
          <label className="mt-2.5 block">
            <span className="font-semibold text-xs">Link</span>
            <input className={FIELD} onChange={set("url")} type="url" value={node.config.url ?? ""} />
          </label>
        )}
      </Section>
      <Section hint="Shows the text exactly as typed." title="Preview">
        <div className="mt-2 rounded-card bg-foreground/90 p-3">
          <div className="mb-1.5 text-[11px] text-background/70">{isSms ? "SMS" : "Notification"}</div>
          <div className="rounded-tile bg-background p-2.5 text-xs">
            <div className="font-semibold text-muted-foreground">Mộc Lan Shop</div>
            {!isSms && node.config.title && <div className="font-semibold">{node.config.title}</div>}
            <div className="whitespace-pre-wrap">{node.config.body}</div>
            {!isSms && node.config.url && <div className="text-primary">{node.config.url}</div>}
          </div>
        </div>
      </Section>
      <Section>
        <button className="font-semibold text-primary text-xs" onClick={onRemove} type="button">
          Remove step
        </button>
        <p className="text-muted-foreground text-xs">
          {nextNode?.type === "end" ? "Removes this step. The End below it stays." : "Removes this step. The step below it moves up."}
        </p>
      </Section>
    </>
  );
}
