/** @jest-environment node */
import { signInLinks } from "@/shared/auth/signInLinks";

describe("signInLinks", () => {
  it("offers one link per provider, in order, with the return path", () => {
    expect(
      signInLinks(
        [
          { id: "keycloak", name: "Keycloak" },
          { id: "entra", name: "Microsoft" },
        ],
        "/campaign/abc?x=1",
      ),
    ).toEqual([
      { label: "Sign in with Keycloak", href: "/api/auth/oidc/login?provider=keycloak&returnTo=%2Fcampaign%2Fabc%3Fx%3D1" },
      { label: "Sign in with Microsoft", href: "/api/auth/oidc/login?provider=entra&returnTo=%2Fcampaign%2Fabc%3Fx%3D1" },
    ]);
  });

  it("leaves out an absent return path", () => {
    expect(signInLinks([{ id: "default", name: "SSO" }], undefined)).toEqual([
      { label: "Sign in with SSO", href: "/api/auth/oidc/login?provider=default" },
    ]);
  });

  it("offers one SSO link without the provider configuration, so the route reports the error", () => {
    expect(signInLinks(null, "/campaign")).toEqual([
      { label: "Sign in with SSO", href: "/api/auth/oidc/login?returnTo=%2Fcampaign" },
    ]);
  });
});
