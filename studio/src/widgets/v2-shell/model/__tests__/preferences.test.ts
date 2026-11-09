import { initials, parseSidebarOpen, workspaceName } from "../preferences";

describe("workspaceName", () => {
  it("reads the configured name", () => {
    expect(workspaceName("  Acme Retail ")).toBe("Acme Retail");
  });

  it.each([undefined, "", "   "])("falls back to Studio for %p", (configured) => {
    expect(workspaceName(configured)).toBe("Studio");
  });
});

describe("parseSidebarOpen", () => {
  it("stays collapsed after the viewer collapsed it", () => {
    expect(parseSidebarOpen("false")).toBe(false);
  });

  it.each([undefined, "true"])("opens for %p", (value) => {
    expect(parseSidebarOpen(value)).toBe(true);
  });
});

describe("initials", () => {
  it.each([
    ["lan.nguyen@example.com", "LN"],
    ["minh@example.com", "MI"],
  ])("abbreviates %p as %p", (email, letters) => {
    expect(initials(email)).toBe(letters);
  });
});
