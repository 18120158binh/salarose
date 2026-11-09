"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatCount } from "@/shared/lib/format";
import { notify } from "@/shared/ui/v2/toast";
import { journeyDraftHref } from "@/widgets/v2-shell/model/routes";
import { createDraftAction } from "../model/actions";
import type { CatalogEvent } from "../model/catalog";
import { blankRoot, prefilledMapping, templateRoot, TEMPLATES, type JourneyTemplate, type PreviewCell } from "../model/templates";

export const MAX_PROMPT_LENGTH = 2000;

// AIG-FR-04: the examples name only push or SMS.
export const EXAMPLES = [
  "Send a push to people in Hà Nội who add to cart but don’t order within 2 hours.",
  "Welcome new sign-ups with a push, then an SMS after 3 days if they haven’t ordered.",
  "Send a push to women in TP. Hồ Chí Minh who view a product over 500,000 ₫ twice in a day.",
] as const;

type Origin = "blank" | "ai" | `template:${string}`;

/** What Describe it shows under the box after a request the route refused. */
export type DescribeFailure = { kind: "minute"; retryAfter: number } | { kind: "day" } | { kind: "failed" };

/** AIG-FR-06: the route's refusal as the board words it. A wait over a minute is the daily limit. */
export function describeFailure(status: number, retryAfterHeader: string | null): DescribeFailure {
  if (status !== 429) return { kind: "failed" };
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 60) return { kind: "day" };
  return { kind: "minute", retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60 };
}

function FailureLine({ failure }: { failure: DescribeFailure }) {
  switch (failure.kind) {
    case "minute":
      return (
        <>
          <b>Too many requests.</b> You can describe up to 10 journeys a minute. Try again in {failure.retryAfter} seconds. No draft was made.
        </>
      );
    case "day":
      return (
        <>
          <b>Daily limit reached.</b> You can describe up to 100 journeys a day. Try again later, or start blank or from a template. No draft
          was made.
        </>
      );
    case "failed":
      return (
        <>
          <b>The journey could not be built.</b> Try again, or say it more simply, like the examples above. No draft was made.
        </>
      );
  }
}

// A draft's name from the sentence that described it.
function nameFromPrompt(prompt: string): string {
  const line = prompt.trim().replace(/\s+/g, " ");
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
}

// JBD-FR-29: every start makes a draft owned by the viewer, then opens it in the builder.
function useCreate() {
  const router = useRouter();
  return async (name: string, root: Record<string, unknown>, origin: Origin): Promise<boolean> => {
    const created = await createDraftAction({ name, description: "", root, origin });
    if ("error" in created) {
      notify({ kind: "failed", title: "The draft could not be made.", description: created.error });
      return false;
    }
    router.push(journeyDraftHref(created.id));
    return true;
  };
}

export function NewJourney({ aiConfigured, catalog }: { aiConfigured: boolean; catalog: readonly CatalogEvent[] }) {
  const create = useCreate();
  const [picked, setPicked] = useState<JourneyTemplate | null>(null);
  const [blankBusy, setBlankBusy] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <section className={cn("grid gap-4", aiConfigured && "lg:grid-cols-[1fr_2fr]")}>
        <article className="flex flex-col gap-3 rounded-card border border-border bg-card p-5">
          <h2 className="font-heading font-semibold text-[0.9375rem]">Start blank</h2>
          <p className="text-muted-foreground text-sm">
            You get one start step. Pick the event that starts the journey, then add waits, checks and messages from the palette.
          </p>
          <Button
            className="mt-auto w-fit"
            disabled={blankBusy}
            onClick={async () => {
              setBlankBusy(true);
              if (!(await create("New journey", blankRoot(), "blank"))) setBlankBusy(false);
            }}
          >
            <PlusIcon aria-hidden />
            Start blank
          </Button>
        </article>
        {aiConfigured && <DescribeIt create={create} />}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading font-semibold text-[0.9375rem]">Start from a template</h2>
          <p className="text-muted-foreground text-sm">
            Ready-made journeys for a Vietnamese shop. Messages are in Vietnamese and use Push or SMS. Edit the names and links before you
            publish.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.map((template) => (
            <TemplateCard key={template.key} onUse={() => setPicked(template)} template={template} />
          ))}
        </div>
      </section>

      <TemplateDialog catalog={catalog} create={create} onClose={() => setPicked(null)} template={picked} />
    </div>
  );
}

function DescribeIt({ create }: { create: ReturnType<typeof useCreate> }) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<DescribeFailure | null>(null);
  const over = prompt.length - MAX_PROMPT_LENGTH;

  async function build(): Promise<void> {
    setWorking(true);
    setFailure(null);
    try {
      const response = await fetch("/api/generate-journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) {
        setFailure(describeFailure(response.status, response.headers.get("Retry-After")));
        return;
      }
      const root = (await response.json()) as Record<string, unknown>;
      if (await create(nameFromPrompt(prompt), root, "ai")) return;
    } catch {
      setFailure({ kind: "failed" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <article aria-labelledby={`${id}-h`} className="flex flex-col gap-3 rounded-card border border-ai-border bg-ai-tint p-5">
      <h2 className="flex items-center gap-2 font-heading font-semibold text-[0.9375rem] text-ai-ink" id={`${id}-h`}>
        <SparklesIcon aria-hidden className="size-4 text-ai" />
        Describe it
      </h2>
      <p className="text-muted-foreground text-sm">Write what should happen in one or two sentences. AI drafts the steps, and you review every one.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-prompt`}>What should this journey do?</Label>
        <Textarea id={`${id}-prompt`} onChange={(event) => setPrompt(event.target.value)} rows={3} value={prompt} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Try:</span>
        {EXAMPLES.map((example) => (
          <button
            className="rounded-full border border-ai-border bg-card px-2.5 py-1 text-left text-ai-ink text-xs outline-none hover:bg-ai-tint focus-visible:ring-2 focus-visible:ring-ring"
            key={example}
            onClick={() => setPrompt(example)}
            type="button"
          >
            {example}
          </button>
        ))}
      </div>
      {failure && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm" role="alert">
          <FailureLine failure={failure} />
        </div>
      )}
      {over > 0 && (
        <div className="text-destructive-foreground text-sm" role="alert">
          Keep it under 2,000 characters. Cut <span className="font-heading tabular-nums">{formatCount(over)}</span> to continue.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          <span className="font-heading tabular-nums">{formatCount(prompt.length)}</span> / 2,000 characters · AI puts event details in the
          start filters and customer details, like city, in who can enter.
        </span>
        {working ? (
          <span className="flex items-center gap-2 text-ai-ink text-sm" role="status">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
            Building your journey. This can take up to a minute.
          </span>
        ) : (
          <Button
            className="bg-ai text-white hover:bg-ai-ink"
            disabled={prompt.trim() === "" || over > 0}
            onClick={() => void build()}
          >
            <SparklesIcon aria-hidden />
            Build journey
          </Button>
        )}
      </div>
    </article>
  );
}

const CELL_TONE: Record<PreviewCell["kind"], string> = {
  start: "border-primary/30 bg-primary/10 text-primary",
  wait: "border-border bg-card",
  message: "border-info/30 bg-info/10 text-info",
  end: "border-transparent bg-muted text-muted-foreground",
  blank: "invisible",
};

function TemplateCard({ template, onUse }: { template: JourneyTemplate; onUse: () => void }) {
  return (
    <article className="flex flex-col gap-3 rounded-card border border-border bg-card p-5">
      <h3 className="font-heading font-semibold text-[0.9375rem]">{template.name}</h3>
      <p className="text-muted-foreground text-sm">{template.purpose}</p>
      <div aria-label={`Steps of ${template.name}`} className="flex flex-col gap-1.5 rounded-md bg-background p-3" role="img">
        {template.preview.map((row, index) => (
          <div className="grid auto-cols-fr grid-flow-col gap-1.5" key={index}>
            {row.map((cell, cellIndex) => (
              <span className={cn("rounded border px-2 py-1 text-center text-xs", CELL_TONE[cell.kind])} key={cellIndex}>
                {cell.text}
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="text-sm">
        <b>Needs:</b> {template.needs.map((need) => need.label).join(", ")}
      </p>
      <p className="text-muted-foreground text-xs">Messages: {template.channels}</p>
      <Button className="mt-auto w-fit" onClick={onUse} variant="outline">
        Use template
      </Button>
    </article>
  );
}

function TemplateDialog({
  template,
  catalog,
  create,
  onClose,
}: {
  template: JourneyTemplate | null;
  catalog: readonly CatalogEvent[];
  create: ReturnType<typeof useCreate>;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={template !== null}>
      {template && <TemplateForm catalog={catalog} create={create} key={template.key} template={template} />}
    </Dialog>
  );
}

const UNMAPPED = "";

function TemplateForm({ template, catalog, create }: { template: JourneyTemplate; catalog: readonly CatalogEvent[]; create: ReturnType<typeof useCreate> }) {
  const id = useId();
  const [mapping, setMapping] = useState<Record<string, string>>(() => prefilledMapping(template, catalog.map((event) => event.name)));
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);
  const missing = template.needs.some((need) => (mapping[need.name] ?? UNMAPPED) === UNMAPPED);

  async function submit(): Promise<void> {
    setBusy(true);
    if (!(await create(name.trim() || template.name, templateRoot(template, mapping), `template:${template.key}`))) setBusy(false);
  }

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>Use “{template.name}”</DialogTitle>
        <DialogDescription>Match each event the template needs to an event your shop sends.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {template.needs.map((need, index) => {
          const fieldId = `${id}-map-${index}`;
          const value = mapping[need.name] ?? UNMAPPED;
          return (
            <div className="flex flex-col gap-1.5" key={need.name}>
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{need.label}</span>
                <span className="font-mono text-muted-foreground text-xs">{need.name}</span>
              </span>
              <Label className="sr-only" htmlFor={fieldId}>
                Your event for {need.label}
              </Label>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id={fieldId}
                onChange={(event) => setMapping((current) => ({ ...current, [need.name]: event.target.value }))}
                value={value}
              >
                <option value={UNMAPPED}>Pick an event…</option>
                {catalog.map((event) => (
                  <option key={event.name} value={event.name}>
                    {event.label} · {event.name}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-xs">
                {value === need.name ? "Found in your events" : value === UNMAPPED ? "Not in your events yet" : "Matched by you"}
              </span>
            </div>
          );
        })}
        {missing && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
            You can make the draft now. Publishing stays blocked until every event is matched, or added to your events by an admin.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Journey name</Label>
          <Input id={`${id}-name`} onChange={(event) => setName(event.target.value)} value={name} />
          <span className="text-muted-foreground text-xs">Makes a draft only you can see.</span>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button disabled={busy} onClick={() => void submit()}>
          Create draft
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
