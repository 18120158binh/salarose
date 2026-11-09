import { KpiCard } from "@/shared/ui/v2/KpiCard";
import type { KpiCounts, KpiView, LagSeries } from "../model/home";
import { lagKpi } from "../model/home";

export function KpiViewCard({ view }: { view: KpiView }) {
  return (
    <KpiCard
      change={view.change}
      definition={view.definition}
      detail={view.detail ?? undefined}
      label={view.label}
      trend={view.trend ?? undefined}
      value={view.value}
    />
  );
}

// Entries, messages requested, and watch success share one read. Each card awaits it in its own
// region, so a failed read shows on the cards it feeds and nowhere else.
export async function CountKpiCard({ counts, view }: { counts: Promise<KpiCounts>; view: (counts: KpiCounts) => KpiView }) {
  return <KpiViewCard view={view(await counts)} />;
}

export async function LagKpiCard({ lag }: { lag: Promise<LagSeries> }) {
  return <KpiViewCard view={lagKpi(await lag)} />;
}
