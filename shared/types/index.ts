import type { EventKind } from "../lib/eventCatalog";

export interface UserEventFieldDef {
  value: string;
  label: string;
  dataType?: string;
  exampleValue?: string;
  defaultValue?: string;
  required?: boolean;
}

export interface UserEventDef {
  id: string;
  name: string;
  label: string;
  description?: string;
  fields: UserEventFieldDef[];
}

export interface UserEventSummary {
  id: string;
  name: string;
  label: string;
  description?: string;
  fieldCount: number;
  enforceSchema: boolean;
  eventKind: EventKind;
  /** The stored status, such as `active`. */
  status: string;
}

export interface UserEventPageCursor {
  eventName: string;
  id: string;
}

export interface UserEventPage {
  events: UserEventSummary[];
  nextCursor: UserEventPageCursor | null;
}

export interface UserEventUsageCampaign {
  id: string;
  name: string;
  status: string;
}

/** What deleting a catalog event also deletes or breaks. */
export interface UserEventUsage {
  /** Each metric with what it computes, such as "Sum of product.price". */
  metrics: { id: string; displayName: string; measure: string }[];
  /** Campaigns with a metric condition on the event. The delete removes those metrics. */
  metricCampaigns: UserEventUsageCampaign[];
  /** Campaigns whose trigger or event condition names the event's system name. */
  conditionCampaigns: UserEventUsageCampaign[];
}
