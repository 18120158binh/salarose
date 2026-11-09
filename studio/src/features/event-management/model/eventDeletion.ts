import type { UserEventUsage, UserEventUsageCampaign } from "@/app/types";

const campaignLines = (campaigns: UserEventUsageCampaign[]) =>
  campaigns.map((campaign) => `- ${campaign.name} (${campaign.status})`);

/**
 * The confirmation text shown before an event is deleted (CAT-FR-08). The delete is refused while
 * a metric definition or a campaign uses the event, so the text names them and says the delete
 * will not go through; metrics are never deleted.
 */
export function eventDeletionWarning(eventLabel: string, usage: UserEventUsage): string {
  const campaigns = [...new Map([...usage.metricCampaigns, ...usage.conditionCampaigns].map((campaign) => [campaign.id, campaign])).values()];
  if (usage.metrics.length === 0 && campaigns.length === 0) return `Delete the event "${eventLabel}" and its attributes?`;
  const lines = [`"${eventLabel}" is in use, so the delete will be refused. Hide it from the builder to retire it.`];
  if (usage.metrics.length > 0) {
    lines.push(
      "",
      "These metric definitions use the event. Metrics are kept for history and never deleted:",
      ...usage.metrics.map((metric) => `- ${metric.displayName} (${metric.id})`),
    );
  }
  if (campaigns.length > 0) lines.push("", "These campaigns use the event:", ...campaignLines(campaigns));
  return lines.join("\n");
}
