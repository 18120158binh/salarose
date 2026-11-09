import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SystemRole } from "@/shared/auth/types";
import type { Dashboard } from "../model/dashboards";

/** DHL-FR-03: every staff user sees the dashboards. With none declared, only an admin sees the panel. */
export function DashboardsPanel({ dashboards, role }: { dashboards: readonly Dashboard[]; role: SystemRole }) {
  if (dashboards.length === 0 && role !== "admin") return null;
  return (
    <section
      aria-labelledby="pipeline-dashboards"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      <h2 className="font-medium text-sm" id="pipeline-dashboards">
        Pipeline dashboards
      </h2>
      {dashboards.length === 0 ? (
        <p className="text-muted-foreground text-sm">No dashboards configured</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {dashboards.map((dashboard) => (
            <li key={`${dashboard.name} ${dashboard.url}`}>
              <Button render={<a href={dashboard.url} rel="noopener noreferrer" target="_blank" />} size="sm" variant="outline">
                {dashboard.name}
                <ArrowUpRightIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
