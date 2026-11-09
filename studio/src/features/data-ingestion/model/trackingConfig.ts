import { studioOrigin } from "./ingestAddress";

/**
 * The deployment's addresses that Tracking setup and Sources put in their samples (DHL-FR-15,
 * DHL-FR-17). A null or empty value means the deployment does not say, and the page shows its
 * "not known yet" state rather than a guess.
 */
export interface TrackingConfig {
  // The collector the trackers send to, without a trailing slash.
  collector: string | null;
  // One per site or app, in the configured order.
  appIds: readonly string[];
  // The origin that serves the data ingestion API: Studio's own.
  ingestOrigin: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseCollector(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.search !== "" || url.hash !== "" || url.username !== "") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function parseAppIds(value: string | undefined): string[] {
  const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => APP_ID.test(id));
  return [...new Set(ids)];
}

export function parseTrackingConfig(env: Env): TrackingConfig {
  return {
    collector: parseCollector(env.TRACKING_COLLECTOR_URL),
    appIds: parseAppIds(env.TRACKING_APP_IDS),
    ingestOrigin: studioOrigin(env),
  };
}
