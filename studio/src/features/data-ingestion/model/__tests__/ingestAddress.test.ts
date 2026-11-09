/** @jest-environment node */
import { eventsUrl, studioOrigin } from "../ingestAddress";

describe("studioOrigin", () => {
  it("takes the origin of the sign-in callback", () => {
    expect(studioOrigin({ OIDC_REDIRECT_URL: "https://studio.example.com/api/auth/oidc/callback" })).toBe("https://studio.example.com");
  });

  it("is null when the setting is missing, blank, or not a web URL", () => {
    expect(studioOrigin({})).toBeNull();
    expect(studioOrigin({ OIDC_REDIRECT_URL: " " })).toBeNull();
    expect(studioOrigin({ OIDC_REDIRECT_URL: "not a url" })).toBeNull();
    expect(studioOrigin({ OIDC_REDIRECT_URL: "ftp://studio.example.com/cb" })).toBeNull();
  });

  it("names a placeholder address when Studio's address is unknown", () => {
    expect(eventsUrl(null)).toBe("https://<studio address>/v1/events");
    expect(eventsUrl("https://studio.example.com")).toBe("https://studio.example.com/v1/events");
  });
});
