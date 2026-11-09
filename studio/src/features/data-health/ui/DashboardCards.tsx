import { ArrowUpRightIcon, LayoutDashboardIcon } from "lucide-react";
import { RegionEmpty } from "@/shared/ui/v2/states";
import type { Dashboard } from "../model/dashboards";

// DHL-FR-03: one card per pipeline dashboard the deployment declares. The page shows this tab to an
// editor only when there is one.
export function DashboardCards({ dashboards }: { dashboards: readonly Dashboard[] }) {
  if (dashboards.length === 0) {
    return (
      <div className="rounded-card border border-border bg-card">
        <RegionEmpty icon={LayoutDashboardIcon} message="No dashboards configured. The deployment chooses which dashboards appear here." />
      </div>
    );
  }
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {dashboards.map((dashboard) => (
        <li key={`${dashboard.name} ${dashboard.url}`}>
          <a
            className="flex items-start gap-3 rounded-card border border-border bg-card p-4 text-card-foreground outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
            href={dashboard.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-muted text-primary">
              <LayoutDashboardIcon aria-hidden className="size-5" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1 font-heading font-semibold">
                {dashboard.name}
                <ArrowUpRightIcon aria-hidden className="size-4 text-muted-foreground" />
              </span>
              <span className="text-muted-foreground text-sm">Opens in a new tab.</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
