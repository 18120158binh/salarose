import type { SystemRole } from "@/shared/auth/types";
import { queryHref, type DeadLetterQuery } from "./deadLetterQuery";

// Data > Monitoring: one section for every event-monitoring view, as tabs in the address.

export const MONITORING_PATH = "/v2/data/monitoring";

export const MONITORING_TABS = ["overview", "dropped", "dashboards"] as const;
export type MonitoringTab = (typeof MONITORING_TABS)[number];

// Undefined when the address names a tab the page does not have. No parameter is the Overview.
export function parseTab(value: string | undefined): MonitoringTab | undefined {
  if (value === undefined) return "overview";
  return MONITORING_TABS.find((tab) => tab === value);
}

// DHL-FR-05: Dropped data is for admins. DHL-FR-03: with no dashboard declared, an editor has no
// Dashboards tab and an admin sees that none is configured.
export function tabsFor(role: SystemRole, dashboards: number): MonitoringTab[] {
  return MONITORING_TABS.filter((tab) => (tab === "dropped" || (tab === "dashboards" && dashboards === 0) ? role === "admin" : true));
}

// The window, reason, and record filters stay in the address across tabs, since the window applies
// to the whole section.
export function monitoringHref(tab: MonitoringTab, query: DeadLetterQuery): string {
  return queryHref(tab === "overview" ? MONITORING_PATH : `${MONITORING_PATH}?tab=${tab}`, query);
}
