"use client";

import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { Checklist as ChecklistModel } from "../model/checklist";
import { StepIcon } from "./StepPanel";

// JBD-FR-25: the checklist drawer of the JourneyPublish board. Problems by step in tree order,
// blocking ones first in each step, each with Go to.
export function ChecklistDrawer({ checklist, onGoTo, onClose }: { checklist: ChecklistModel; onGoTo: (nodeId: string) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside aria-label="Checklist" className="flex w-[360px] shrink-0 flex-col border-border border-l bg-card">
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <h2 className="font-heading font-semibold text-base">Checklist</h2>
        <Button aria-label="Close checklist (Esc)" onClick={onClose} size="icon" title="Close (Esc)" variant="ghost">
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="space-y-2 border-border border-b px-4 py-3">
        <div className="flex flex-wrap gap-2 text-xs">
          {checklist.blocks > 0 ? <Blocks count={checklist.blocks} /> : <NothingBlocks />}
          {checklist.warnings > 0 && <Warnings count={checklist.warnings} />}
        </div>
        <p className="text-muted-foreground text-xs">
          Checked a moment after your last edit, the same way publishing checks. Problems are listed in step order.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {checklist.groups.length === 0 && <p className="px-4 py-6 text-muted-foreground text-sm">No problems found.</p>}
        {checklist.groups.map((group) => (
          <section className="border-border border-b px-4 py-3" key={group.nodeId ?? "journey"}>
            <div className="mb-2 flex items-center gap-2">
              {group.node && <StepIcon node={group.node} />}
              <h3 className="font-semibold text-sm">{group.title}</h3>
            </div>
            <ul className="space-y-2">
              {group.items.map((item, index) => (
                <li className="flex items-start gap-2 text-sm" key={`${item.field}-${index}`}>
                  {item.severity === "blocking" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 font-semibold text-destructive text-xs">
                      <CircleAlertIcon aria-hidden className="size-3" />
                      Blocks
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 font-semibold text-warning text-xs">
                      <TriangleAlertIcon aria-hidden className="size-3" />
                      Warning
                    </span>
                  )}
                  <div className="flex-1">
                    {item.field && <b>{item.field}: </b>}
                    {item.message}
                  </div>
                  {group.nodeId && (
                    <Button onClick={() => onGoTo(group.nodeId!)} size="sm" variant="outline">
                      Go to
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="border-border border-t px-4 py-3 text-muted-foreground text-xs">
        Blocking problems stop publishing. Warnings don&apos;t, but read them: they usually mean people won&apos;t move the way you expect.
      </p>
    </aside>
  );
}

function Blocks({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-destructive">
      <CircleAlertIcon aria-hidden className="size-3" />
      <span className="font-heading tabular-nums">{count}</span> {count === 1 ? "blocks" : "block"} publishing
    </span>
  );
}

function NothingBlocks() {
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-success">
      <CircleCheckIcon aria-hidden className="size-3" />
      Nothing blocks publishing
    </span>
  );
}

function Warnings({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-warning">
      <TriangleAlertIcon aria-hidden className="size-3" />
      <span className="font-heading tabular-nums">{count}</span> warning{count === 1 ? "" : "s"}
    </span>
  );
}
