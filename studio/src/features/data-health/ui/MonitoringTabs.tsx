import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatCount, type Reading } from "@/shared/lib/format";
import type { DeadLetterQuery } from "../model/deadLetterQuery";
import { monitoringHref, type MonitoringTab } from "../model/monitoring";

const LABELS: Record<MonitoringTab, string> = { overview: "Overview", dropped: "Dropped data", dashboards: "Dashboards" };

export interface MonitoringTabsProps {
  tabs: readonly MonitoringTab[];
  current: MonitoringTab;
  query: DeadLetterQuery;
  // The Dropped data tab's count, as the Overview card reads it.
  dropped: Promise<Reading<number>>;
}

// DHL-FR-13: the section's tabs, as links, so each tab has its own address.
export function MonitoringTabs({ tabs, current, query, dropped }: MonitoringTabsProps) {
  return (
    <nav aria-label="Monitoring" className="flex gap-1 border-border border-b">
      {tabs.map((tab) => (
        <Link
          aria-current={tab === current ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            tab === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          href={monitoringHref(tab, query)}
          key={tab}
          scroll={false}
        >
          {LABELS[tab]}
          {tab === "dropped" && (
            <Suspense fallback={null}>
              <Count reading={dropped} />
            </Suspense>
          )}
        </Link>
      ))}
    </nav>
  );
}

async function Count({ reading }: { reading: Promise<Reading<number>> }): Promise<ReactNode> {
  const count = await reading;
  if (!count.available) return null;
  return <span className="rounded-full bg-muted px-1.5 font-heading text-muted-foreground text-xs tabular-nums">{formatCount(count.value)}</span>;
}
