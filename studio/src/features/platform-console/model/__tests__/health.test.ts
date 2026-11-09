/** @jest-environment node */
import { ARGOCD_APP_FIELDS, checkHealth, type HealthDeps } from "../health";
import type { HealthCheck } from "../tools";

const TOKEN = "argocd-secret-token-value";

type Route = { status: number; body?: unknown } | "timeout" | "refused";

// A fake network: each URL answers with its route, and an unknown URL refuses the connection.
function network(routes: Record<string, Route>, { token }: { token?: string } = { token: TOKEN }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const deps: HealthDeps = {
    argocdToken: token,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const route = routes[url] ?? "refused";
      if (route === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (route === "refused") throw new TypeError("fetch failed");
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status });
    },
  };
  return { deps, calls };
}

function app(name: string, sync: string, health: string) {
  return { metadata: { name }, status: { sync: { status: sync }, health: { status: health } } };
}

function flinkOverview(state: string, running: number, total: number) {
  return { jobs: [{ jid: "abc", name: "job", state, "start-time": 1, tasks: { running, total } }] };
}

const ARGOCD: HealthCheck = { kind: "argocd", url: "http://argocd" };
const ARGOCD_APPS = `http://argocd/api/v1/applications?fields=${ARGOCD_APP_FIELDS.join(",")}`;
const GRAFANA: HealthCheck = { kind: "grafana", url: "http://grafana" };
const GRAFANA_HEALTH = "http://grafana/api/health";
const JOBS = ["event-parse-job", "customer-decision-job", "campaign-outbox-job"];
const FLINK: HealthCheck = { kind: "flink", jobs: JOBS.map((name) => ({ name, url: `http://${name}-rest:8081` })) };
const overviewUrl = (job: string) => `http://${job}-rest:8081/jobs/overview`;
const HTTP: HealthCheck = { kind: "http", url: "http://kafka-ui" };

describe("Argo CD health", () => {
  it("is up when every application is synced and healthy, and sends the token only to Argo CD", async () => {
    const { deps, calls } = network({
      [ARGOCD_APPS]: { status: 200, body: { items: [app("cdp", "Synced", "Healthy"), app("platform", "Synced", "Healthy")] } },
    });

    expect(await checkHealth(ARGOCD, deps)).toEqual({
      status: "up",
      reason: "2 applications synced and healthy",
      details: { kind: "argocd", apps: [] },
    });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("asks Argo CD only for each application's name, sync status, and health status", async () => {
    const { deps, calls } = network({ [ARGOCD_APPS]: { status: 200, body: { items: [] } } });

    await checkHealth(ARGOCD, deps);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/applications");
    expect(url.searchParams.get("fields")?.split(",").sort()).toEqual(
      ["items.metadata.name", "items.status.health.status", "items.status.sync.status"],
    );
  });

  it("is degraded and names the applications out of sync, progressing, or degraded", async () => {
    const { deps } = network({
      [ARGOCD_APPS]: {
        status: 200,
        body: { items: [app("cdp", "OutOfSync", "Healthy"), app("web", "Synced", "Progressing"), app("ok", "Synced", "Healthy")] },
      },
    });

    const health = await checkHealth(ARGOCD, deps);
    expect(health.status).toBe("degraded");
    expect(health.reason).toContain("cdp: OutOfSync");
    expect(health.reason).toContain("web: Synced, Progressing");
    expect(health.reason).not.toContain("ok:");
    expect(health.details).toEqual({
      kind: "argocd",
      apps: [
        { name: "cdp", sync: "OutOfSync", health: "Healthy" },
        { name: "web", sync: "Synced", health: "Progressing" },
      ],
    });
  });

  it("is unknown without a token and calls nothing", async () => {
    const { deps, calls } = network({}, {});

    expect(await checkHealth(ARGOCD, deps)).toEqual({ status: "unknown", reason: "not configured" });
    expect(calls).toHaveLength(0);
  });

  it("is unknown when Argo CD rejects the token", async () => {
    const { deps } = network({ [ARGOCD_APPS]: { status: 401, body: { error: `invalid token ${TOKEN}` } } });

    expect(await checkHealth(ARGOCD, deps)).toEqual({ status: "unknown", reason: "token rejected" });
  });

  it("is down when Argo CD does not answer or fails", async () => {
    expect((await checkHealth(ARGOCD, network({}).deps)).status).toBe("down");
    expect((await checkHealth(ARGOCD, network({ [ARGOCD_APPS]: { status: 502 } }).deps)).status).toBe("down");
  });
});

describe("Grafana health", () => {
  it("is up when its health endpoint answers healthy", async () => {
    const { deps } = network({ [GRAFANA_HEALTH]: { status: 200, body: { database: "ok", version: "12.0.0" } } });

    expect((await checkHealth(GRAFANA, deps)).status).toBe("up");
  });

  it("is degraded when its health endpoint reports a failing database", async () => {
    const { deps } = network({ [GRAFANA_HEALTH]: { status: 503, body: { database: "failing" } } });

    expect(await checkHealth(GRAFANA, deps)).toEqual({ status: "degraded", reason: "database failing" });
  });

  it("is unknown when it answers success without a healthy database", async () => {
    const { deps } = network({ [GRAFANA_HEALTH]: { status: 200, body: { version: "12.0.0" } } });

    expect(await checkHealth(GRAFANA, deps)).toEqual({ status: "unknown", reason: "unexpected answer" });
  });

  it("is down when Grafana is stopped", async () => {
    expect(await checkHealth(GRAFANA, network({}).deps)).toEqual({ status: "down", reason: "no answer" });
  });
});

describe("Flink health", () => {
  it("is up when every job is running with all its tasks", async () => {
    const { deps } = network(Object.fromEntries(JOBS.map((job) => [overviewUrl(job), { status: 200, body: flinkOverview("RUNNING", 4, 4) }])));

    expect(await checkHealth(FLINK, deps)).toEqual({
      status: "up",
      reason: "3 jobs running",
      details: { kind: "flink", jobs: JOBS.map((name) => ({ name, fine: true, state: "RUNNING" })) },
    });
  });

  it("is degraded and names a restarting job", async () => {
    const { deps } = network({
      [overviewUrl("event-parse-job")]: { status: 200, body: flinkOverview("RESTARTING", 0, 4) },
      [overviewUrl("customer-decision-job")]: { status: 200, body: flinkOverview("RUNNING", 4, 4) },
      [overviewUrl("campaign-outbox-job")]: { status: 200, body: flinkOverview("RUNNING", 2, 4) },
    });

    const health = await checkHealth(FLINK, deps);
    expect(health.status).toBe("degraded");
    expect(health.reason).toContain("event-parse-job: RESTARTING");
    expect(health.reason).toContain("campaign-outbox-job: RUNNING, 2 of 4 tasks running");
    expect(health.reason).not.toContain("customer-decision-job");
    expect(health.details).toEqual({
      kind: "flink",
      jobs: [
        { name: "event-parse-job", fine: false, state: "RESTARTING" },
        { name: "customer-decision-job", fine: true, state: "RUNNING" },
        { name: "campaign-outbox-job", fine: false, state: "RUNNING, 2 of 4 tasks running" },
      ],
    });
  });

  it("is degraded and names a job it cannot reach while others answer", async () => {
    const { deps } = network({
      [overviewUrl("event-parse-job")]: { status: 200, body: flinkOverview("RUNNING", 4, 4) },
      [overviewUrl("customer-decision-job")]: { status: 200, body: flinkOverview("RUNNING", 4, 4) },
    });

    const health = await checkHealth(FLINK, deps);
    expect(health.status).toBe("degraded");
    expect(health.reason).toBe("campaign-outbox-job: unreachable");
    expect(health.details).toEqual({
      kind: "flink",
      jobs: [
        { name: "event-parse-job", fine: true, state: "RUNNING" },
        { name: "customer-decision-job", fine: true, state: "RUNNING" },
        { name: "campaign-outbox-job", fine: false, state: "Not known" },
      ],
    });
  });

  it("is down when no job can be read", async () => {
    expect(await checkHealth(FLINK, network({}).deps)).toEqual({ status: "down", reason: "jobs cannot be read" });
  });
});

describe("health of any other tool", () => {
  it("is up when its address answers with success or a redirect", async () => {
    expect((await checkHealth(HTTP, network({ "http://kafka-ui": { status: 200 } }).deps)).status).toBe("up");
    expect((await checkHealth(HTTP, network({ "http://kafka-ui": { status: 302 } }).deps)).status).toBe("up");
  });

  it("is down when its address fails or does not answer", async () => {
    expect((await checkHealth(HTTP, network({ "http://kafka-ui": { status: 500 } }).deps)).status).toBe("down");
    expect((await checkHealth(HTTP, network({}).deps)).status).toBe("down");
  });
});

describe("every check", () => {
  it("is unknown with the reason 'timed out' when the tool is slow", async () => {
    const slow = network({
      [ARGOCD_APPS]: "timeout",
      [GRAFANA_HEALTH]: "timeout",
      "http://kafka-ui": "timeout",
      ...Object.fromEntries(JOBS.map((job) => [overviewUrl(job), "timeout" as const])),
    });

    for (const check of [ARGOCD, GRAFANA, FLINK, HTTP]) {
      expect(await checkHealth(check, slow.deps)).toEqual({ status: "unknown", reason: "timed out" });
    }
  });

  it("asks once, uncached, with a timeout", async () => {
    const { deps, calls } = network({ [GRAFANA_HEALTH]: "refused" });

    await checkHealth(GRAFANA, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.cache).toBe("no-store");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never puts the token or a response body in a reason", async () => {
    const leaky = { error: `token ${TOKEN} rejected`, database: `failing: password=${TOKEN}` };
    const reasons = await Promise.all([
      checkHealth(ARGOCD, network({ [ARGOCD_APPS]: { status: 403, body: leaky } }).deps),
      checkHealth(ARGOCD, network({ [ARGOCD_APPS]: { status: 200, body: { items: [app(`x ${TOKEN}`, "OutOfSync", "Missing")] } } }).deps),
      checkHealth(GRAFANA, network({ [GRAFANA_HEALTH]: { status: 503, body: leaky } }).deps),
      checkHealth(FLINK, network({ [overviewUrl("event-parse-job")]: { status: 200, body: flinkOverview(`FAILED ${TOKEN}`, 0, 1) } }).deps),
    ]);

    for (const { reason } of reasons) expect(reason).not.toContain(TOKEN);
  });
});
