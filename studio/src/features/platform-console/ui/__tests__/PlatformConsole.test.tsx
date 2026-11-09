/** @jest-environment node */
import { renderToReadableStream } from "react-dom/server";
import type { Health } from "../../model/health";
import { parsePlatformConfig, type PlatformConfig } from "../../model/tools";
import { PlatformConsole } from "../PlatformConsole";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.spyOn(console, "warn").mockImplementation(() => {});

const config = parsePlatformConfig({
  PLATFORM_TOOLS: JSON.stringify([
    {
      id: "flink",
      name: "Flink",
      purpose: "Runs the real-time jobs",
      url: "https://flink.example.io",
      signIn: "sso",
      health: { kind: "flink", jobs: [{ name: "customer-decision-job", url: "http://decision:8081" }] },
    },
    {
      id: "grafana",
      name: "Grafana",
      purpose: "Charts and alerts",
      url: "https://grafana.example.io",
      signIn: "sso",
      health: { kind: "grafana", url: "http://grafana" },
    },
    { id: "kafka", name: "Kafka browser" },
  ]),
  PLATFORM_QUICK_LINKS: JSON.stringify([{ label: "Repository", url: "https://github.com/acme/repo" }]),
});

async function render(platform: PlatformConfig, health: Record<string, Health>): Promise<string> {
  const stream = await renderToReadableStream(
    <PlatformConsole
      checkedAt={() => 80_000}
      config={platform}
      healthOf={(tool) => Promise.resolve(health[tool.id])}
      now={() => 100_000}
    />,
  );
  await stream.allReady;
  return new Response(stream).text();
}

describe("PlatformConsole", () => {
  it("names the one tool that needs attention, tints it, and shows the check time (PCN-FR-12)", async () => {
    const html = await render(config, {
      flink: { status: "degraded", reason: "customer-decision-job: RESTARTING" },
      grafana: { status: "up", reason: "healthy" },
    });

    expect(html).toContain("NEEDS ATTENTION");
    expect(html).toContain("1 tool needs attention: Flink · customer-decision-job: RESTARTING");
    expect(html).toContain("1 of 3 tools are up.");
    expect(html).toContain("Checked 20 s ago");
    expect(html).toContain('href="#tool-flink"');
    expect(html).toMatch(/<tbody class="[^"]*bg-warning\/5[^"]*" id="tool-flink"/);
  });

  it("shows a tool without configuration as Unknown, with no address and an unknown sign-in (PCN-FR-02)", async () => {
    const html = await render(config, { flink: { status: "up", reason: "1 job running" }, grafana: { status: "up", reason: "healthy" } });

    expect(html).toContain("Kafka browser · Not configured");
    expect(html).toContain("Not known");
    expect(html).toContain("The configuration of this tool is missing or invalid, so it has no address.");
  });

  it("lists Flink's jobs with each state and UI, closed while Flink is up (PCN-FR-06, PCN-FR-14, PCN-FR-16)", async () => {
    const html = await render(config, {
      flink: { status: "up", reason: "1 job running", details: { kind: "flink", jobs: [{ name: "customer-decision-job", fine: true, state: "RUNNING" }] } },
      grafana: { status: "up", reason: "healthy" },
    });

    expect(html).toContain("Jobs (1)");
    expect(html).toContain('href="https://flink.example.io/customer-decision-job/"');
    expect(html).toContain("Running");
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("Single sign-on");
    expect(html).toContain("Repository");
  });

  it("opens a degraded Flink's jobs with the job not running first (PCN-FR-16)", async () => {
    const flink = {
      id: "flink",
      name: "Flink",
      purpose: "Runs the real-time jobs",
      url: "https://flink.example.io",
      signIn: "sso",
      health: { kind: "flink", jobs: [{ name: "event-parse-job", url: "http://a:8081" }, { name: "campaign-outbox-job", url: "http://b:8081" }] },
    };
    const html = await render(parsePlatformConfig({ PLATFORM_TOOLS: JSON.stringify([flink]) }), {
      flink: {
        status: "degraded",
        reason: "campaign-outbox-job: RESTARTING",
        details: {
          kind: "flink",
          jobs: [
            { name: "event-parse-job", fine: true, state: "RUNNING" },
            { name: "campaign-outbox-job", fine: false, state: "RESTARTING" },
          ],
        },
      },
    });

    expect(html).toMatch(/<details[^>]*open/);
    expect(html.lastIndexOf(">campaign-outbox-job<")).toBeLessThan(html.lastIndexOf(">event-parse-job<"));
    expect(html).toContain("RESTARTING");
  });

  it("shows a job the check could not read as Not known (PCN-FR-14)", async () => {
    const html = await render(config, {
      flink: { status: "degraded", reason: "customer-decision-job: unreachable", details: { kind: "flink", jobs: [{ name: "customer-decision-job", fine: false, state: "Not known" }] } },
      grafana: { status: "up", reason: "healthy" },
    });

    expect(html).toMatch(/Not known/);
    expect(html).not.toContain("State not available yet");
  });

  it("lists each Argo CD app not synced and healthy, with both statuses and its Argo CD link (PCN-FR-14)", async () => {
    const argocd = { id: "argocd", name: "Argo CD", purpose: "Deploys the platform", url: "https://argocd.example.io", signIn: "sso", health: { kind: "argocd", url: "http://argocd" } };
    const html = await render(parsePlatformConfig({ PLATFORM_TOOLS: JSON.stringify([argocd]) }), {
      argocd: { status: "degraded", reason: "studio: OutOfSync, Healthy", details: { kind: "argocd", apps: [{ name: "studio", sync: "OutOfSync", health: "Healthy" }] } },
    });

    expect(html).toContain("Apps (1)");
    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain("OutOfSync");
    expect(html).toContain('href="https://argocd.example.io/applications/studio"');
    expect(html).toContain("Every other app is synced and healthy.");
  });

  it("shows no app list when every Argo CD app is synced and healthy", async () => {
    const argocd = { id: "argocd", name: "Argo CD", purpose: "Deploys the platform", url: "https://argocd.example.io", signIn: "sso", health: { kind: "argocd", url: "http://argocd" } };
    const html = await render(parsePlatformConfig({ PLATFORM_TOOLS: JSON.stringify([argocd]) }), {
      argocd: { status: "up", reason: "14 applications synced and healthy", details: { kind: "argocd", apps: [] } },
    });

    expect(html).not.toContain("Apps (");
  });

  it("reads NOTHING TO CHECK with Not checked when no tool is configured (PCN-FR-12)", async () => {
    const html = await render(parsePlatformConfig({}), {});

    expect(html).toContain("NOTHING TO CHECK");
    expect(html).toContain("No tools to check");
    expect(html).toContain("Not checked");
    expect(html).toContain("No tools are configured.");
  });
});
