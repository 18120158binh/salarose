import React, { act } from "react";
import { render, screen, within } from "@testing-library/react";
import type { Health } from "../../model/health";
import { parsePlatformConfig, type ConfiguredTool } from "../../model/tools";
import { PlatformView } from "../PlatformView";

// The invalid entry below is meant; keep its warning out of the test output.
jest.spyOn(console, "warn").mockImplementation(() => {});

const config = parsePlatformConfig({
  PLATFORM_TOOLS: JSON.stringify([
    {
      id: "flink",
      name: "Flink",
      purpose: "Job UIs",
      url: "https://flink.example.io",
      signIn: "sso",
      health: { kind: "flink", jobs: [{ name: "event-parse-job", url: "http://event-parse-job-rest.cdp.svc:8081" }] },
    },
    {
      id: "grafana",
      name: "Grafana",
      purpose: "Dashboards",
      url: "https://grafana.example.io",
      signIn: "own-login",
      health: { kind: "grafana", url: "http://kps-grafana.monitoring.svc" },
      links: [{ label: "Flink jobs dashboard", url: "https://grafana.example.io/d/flink-jobs" }],
    },
    { id: "broken", name: "Broken tool" },
  ]),
  PLATFORM_QUICK_LINKS: JSON.stringify([{ label: "Repository", url: "https://github.com/acme/repo" }]),
});

// Each tool's health settles only when the test says so, like a slow check.
function pendingHealth() {
  const settle = new Map<string, (health: Health) => void>();
  const promises = new Map<string, Promise<Health>>();
  const healthOf = (tool: ConfiguredTool) => {
    if (!promises.has(tool.id)) promises.set(tool.id, new Promise((resolve) => settle.set(tool.id, resolve)));
    return promises.get(tool.id)!;
  };
  return { healthOf, settle: (id: string, health: Health) => settle.get(id)!(health) };
}

function card(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("li")!;
}

describe("PlatformView", () => {
  it("shows every card before any health check finishes, then each health as it completes", async () => {
    const { healthOf, settle } = pendingHealth();
    await act(async () => {
      render(<PlatformView config={config} healthOf={healthOf} />);
    });

    expect(within(card("Flink")).getByText("checking")).toBeInTheDocument();
    expect(within(card("Grafana")).getByText("checking")).toBeInTheDocument();

    await act(async () => settle("grafana", { status: "down", reason: "no answer" }));
    expect(within(card("Grafana")).getByText("down")).toBeInTheDocument();
    expect(within(card("Grafana")).getByText("no answer")).toBeInTheDocument();
    expect(within(card("Flink")).getByText("checking")).toBeInTheDocument();

    await act(async () => settle("flink", { status: "degraded", reason: "event-parse-job: RESTARTING" }));
    expect(within(card("Flink")).getByText("event-parse-job: RESTARTING")).toBeInTheDocument();
  });

  it("shows each tool's purpose, address, sign-in kind, and links, opening in a new tab", () => {
    render(<PlatformView config={config} healthOf={pendingHealth().healthOf} />);

    const flink = within(card("Flink"));
    expect(flink.getByText("Job UIs")).toBeInTheDocument();
    expect(flink.getByText("Single sign-on")).toBeInTheDocument();
    expect(flink.getByRole("link", { name: "flink.example.io (opens in a new tab)" })).toHaveAttribute("href", "https://flink.example.io");
    expect(flink.getByRole("link", { name: "event-parse-job (opens in a new tab)" })).toHaveAttribute(
      "href",
      "https://flink.example.io/event-parse-job/",
    );

    const grafana = within(card("Grafana"));
    expect(grafana.getByText("Own login")).toBeInTheDocument();
    const dashboard = grafana.getByRole("link", { name: "Flink jobs dashboard (opens in a new tab)" });
    expect(dashboard).toHaveAttribute("target", "_blank");
    expect(dashboard).toHaveAttribute("rel", expect.stringContaining("noopener"));

    expect(screen.getByRole("link", { name: "Repository (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/acme/repo");
  });

  it("tells every user that a link opens a new tab", () => {
    render(<PlatformView config={config} healthOf={pendingHealth().healthOf} />);

    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAccessibleName(/\(opens in a new tab\)$/);
      expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("announces a tool's health from a live region that stays in place when the check completes", async () => {
    const { healthOf, settle } = pendingHealth();
    await act(async () => {
      render(<PlatformView config={config} healthOf={healthOf} />);
    });

    const region = within(card("Flink")).getByText("checking").closest("[aria-live]");
    expect(region).toHaveAttribute("aria-live", "polite");

    await act(async () => settle("flink", { status: "up", reason: "1 job running" }));
    const settled = within(card("Flink")).getByText("1 job running").closest("[aria-live]");
    expect(settled).toBe(region);
    expect(region).toBeInTheDocument();
  });

  it("shows a tool with an invalid configuration as unknown, not configured, without checking it", () => {
    const healthOf = jest.fn(pendingHealth().healthOf);
    render(<PlatformView config={config} healthOf={healthOf} />);

    const broken = within(card("Broken tool"));
    expect(broken.getByText("unknown")).toBeInTheDocument();
    expect(broken.getByText("not configured")).toBeInTheDocument();
    expect(healthOf.mock.calls.map(([tool]) => tool.id)).not.toContain("broken");
  });

  it("says why there are no tools when the configuration is missing", () => {
    render(<PlatformView config={parsePlatformConfig({})} healthOf={pendingHealth().healthOf} />);

    expect(screen.getByText(/Set PLATFORM_TOOLS/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Quick links" })).not.toBeInTheDocument();
  });

  it("never shows an internal health address", () => {
    const { container } = render(<PlatformView config={config} healthOf={pendingHealth().healthOf} />);

    expect(container.innerHTML).not.toContain(".svc");
  });
});
