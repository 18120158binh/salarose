/** @jest-environment node */
import { sanitizeReturnTo } from "@/shared/auth/returnTo";

describe("sanitizeReturnTo", () => {
  it.each(["/campaign/abc?x=1", "/admin/events", "/v2/journeys"])("keeps the same-origin path %p", (value) => {
    expect(sanitizeReturnTo(value)).toBe(value);
  });

  it.each([
    null,
    "",
    "campaign",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/login",
    "/api/auth/oidc/login",
    "/\t/evil.example",
    "/\n/evil.example",
    `/${"a".repeat(2048)}`,
  ])("replaces %p with /campaign", (value) => {
    expect(sanitizeReturnTo(value)).toBe("/campaign");
  });
});
