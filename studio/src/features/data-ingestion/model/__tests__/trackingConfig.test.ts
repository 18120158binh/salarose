/** @jest-environment node */
import { parseTrackingConfig } from "../trackingConfig";

describe("parseTrackingConfig", () => {
  it("reads the collector, the app ids, and the ingestion origin when set", () => {
    expect(
      parseTrackingConfig({
        TRACKING_COLLECTOR_URL: "https://collect.acme.com/",
        TRACKING_APP_IDS: "acme-web, acme-app",
        OIDC_REDIRECT_URL: "https://api.acme.com/api/auth/oidc/callback",
      }),
    ).toEqual({ collector: "https://collect.acme.com", appIds: ["acme-web", "acme-app"], ingestOrigin: "https://api.acme.com" });
  });

  it("knows nothing when nothing is set", () => {
    expect(parseTrackingConfig({})).toEqual({ collector: null, appIds: [], ingestOrigin: null });
    expect(parseTrackingConfig({ TRACKING_COLLECTOR_URL: " ", TRACKING_APP_IDS: " , " })).toEqual({ collector: null, appIds: [], ingestOrigin: null });
  });

  it("refuses a malformed collector address rather than showing it", () => {
    for (const value of ["collect.acme.com", "ftp://collect.acme.com", "https://collect.acme.com/?x=1", "https://user@collect.acme.com"]) {
      expect(parseTrackingConfig({ TRACKING_COLLECTOR_URL: value }).collector).toBeNull();
    }
  });

  it("keeps a collector path", () => {
    expect(parseTrackingConfig({ TRACKING_COLLECTOR_URL: "https://acme.com/collect/" }).collector).toBe("https://acme.com/collect");
  });

  it("skips malformed and repeated app ids and keeps the rest", () => {
    expect(parseTrackingConfig({ TRACKING_APP_IDS: "acme-web,has space,'quoted',acme-web,,acme.app_2" }).appIds).toEqual(["acme-web", "acme.app_2"]);
  });
});
