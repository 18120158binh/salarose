/** @jest-environment node */
import { parsePlatformConfig, toolLinks, type ConfiguredTool } from "../tools";

const argocd = {
  id: "argocd",
  name: "Argo CD",
  purpose: "Deploys the platform from git",
  url: "https://argocd.example.io/",
  signIn: "sso",
  health: { kind: "argocd", url: "http://argocd-server.argocd.svc" },
};
const grafana = {
  id: "grafana",
  name: "Grafana",
  purpose: "Dashboards",
  url: "https://grafana.example.io",
  signIn: "sso",
  health: { kind: "grafana", url: "http://kps-grafana.monitoring.svc" },
  links: [{ label: "Flink jobs dashboard", url: "https://grafana.example.io/d/flink-jobs" }],
};
const flink = {
  id: "flink",
  name: "Flink",
  purpose: "Job UIs",
  url: "https://flink.example.io",
  signIn: "sso",
  health: {
    kind: "flink",
    jobs: [
      { name: "event-parse-job", url: "http://event-parse-job-rest.cdp.svc:8081" },
      { name: "campaign-outbox-job", url: "http://campaign-outbox-job-rest.cdp.svc:8081" },
    ],
  },
};
const kafka = {
  id: "kafka",
  name: "Kafka browser",
  purpose: "Topics and messages",
  url: "https://kafka.example.io",
  signIn: "sso",
  health: { kind: "http", url: "http://kafka-ui.cdp.svc" },
};

function parse(tools: unknown, quickLinks?: unknown) {
  return parsePlatformConfig({
    PLATFORM_TOOLS: typeof tools === "string" ? tools : JSON.stringify(tools),
    PLATFORM_QUICK_LINKS: quickLinks === undefined ? undefined : JSON.stringify(quickLinks),
  });
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("platform configuration", () => {
  it("reads every tool and quick link of a valid configuration", () => {
    const config = parse([argocd, grafana], [{ label: "Repository", url: "https://github.com/acme/repo" }]);

    expect(config.problem).toBeNull();
    expect(config.tools).toEqual([
      {
        status: "configured",
        id: "argocd",
        name: "Argo CD",
        purpose: "Deploys the platform from git",
        url: "https://argocd.example.io",
        signIn: "sso",
        health: { kind: "argocd", url: "http://argocd-server.argocd.svc" },
        links: [],
      },
      expect.objectContaining({ id: "grafana", links: grafana.links }),
    ]);
    expect(config.quickLinks).toEqual([{ label: "Repository", url: "https://github.com/acme/repo" }]);
  });

  it("shows no tools and says why when PLATFORM_TOOLS is missing", () => {
    const config = parsePlatformConfig({});

    expect(config.tools).toEqual([]);
    expect(config.quickLinks).toEqual([]);
    expect(config.problem).toMatch(/PLATFORM_TOOLS/);
  });

  it("shows no tools and says why when PLATFORM_TOOLS is not a JSON array", () => {
    for (const raw of ["{not json", JSON.stringify({ tools: [] })]) {
      const config = parse(raw, [{ label: "Repository", url: "https://github.com/acme/repo" }]);
      expect(config.tools).toEqual([]);
      expect(config.problem).toMatch(/not a JSON array/);
      expect(config.quickLinks).toHaveLength(1);
    }
  });

  it("keeps an entry with an id and a name but an invalid rest as not configured", () => {
    const config = parse([
      { ...kafka, signIn: "password" },
      { ...grafana, health: { kind: "prometheus", url: "http://x" } },
      { id: "bare", name: "Bare" },
    ]);

    expect(config.tools).toEqual([
      { status: "not-configured", id: "kafka", name: "Kafka browser" },
      { status: "not-configured", id: "grafana", name: "Grafana" },
      { status: "not-configured", id: "bare", name: "Bare" },
    ]);
  });

  it("drops an entry without an id or a name, and a repeated id", () => {
    const config = parse([{ name: "No id" }, { id: "x", name: " " }, "argocd", argocd, { ...argocd, name: "Copy" }]);

    expect(config.tools.map((tool) => tool.name)).toEqual(["Argo CD"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("accepts only http and https addresses", () => {
    const config = parse(
      [
        { ...argocd, url: "javascript:alert(1)" },
        { ...kafka, health: { kind: "http", url: "file:///etc/passwd" } },
        { ...grafana, links: [{ label: "Bad", url: "ftp://grafana.example.io" }] },
        { ...flink, health: { kind: "flink", jobs: [{ name: "job", url: "not a url" }] } },
      ],
      [{ label: "Bad", url: "mailto:ops@example.io" }, { label: "Good", url: "http://ci.example.io" }],
    );

    expect(config.tools.every((tool) => tool.status === "not-configured")).toBe(true);
    expect(config.quickLinks).toEqual([{ label: "Good", url: "http://ci.example.io" }]);
  });

  it("orders Argo CD, Grafana, and Flink first, then other tools in configured order", () => {
    const docs = { ...kafka, id: "docs", name: "Docs" };
    const broken = { id: "broken", name: "Broken" };
    const config = parse([kafka, flink, broken, grafana, docs, argocd]);

    expect(config.tools.map((tool) => tool.id)).toEqual(["argocd", "grafana", "flink", "kafka", "broken", "docs"]);
  });

  it("links a Flink card to each job's UI under the landing page", () => {
    const tool = parse([flink]).tools[0] as ConfiguredTool;

    expect(toolLinks(tool)).toEqual([
      { label: "event-parse-job", url: "https://flink.example.io/event-parse-job/" },
      { label: "campaign-outbox-job", url: "https://flink.example.io/campaign-outbox-job/" },
    ]);
  });
});
