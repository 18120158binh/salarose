/** @jest-environment node */
import { checkedText, platformStatus, type ToolResult } from "../status";

const tool = (name: string, status: ToolResult["status"], reason = "healthy"): ToolResult => ({ id: name.toLowerCase(), name, status, reason });
const UP4 = [tool("Argo CD", "up"), tool("Grafana", "up"), tool("Flink", "up"), tool("Kafka browser", "up")];

describe("platform status (PCN-FR-12)", () => {
  it("reads OK and names every tool when all are up", () => {
    const status = platformStatus(UP4);
    expect(status).toMatchObject({ word: "OK", title: "All tools are up", listed: [] });
    expect(status.line).toBe("Argo CD, Grafana, Flink and Kafka browser all passed their checks.");
  });

  it("names the one tool that needs attention, with its reason", () => {
    const status = platformStatus([tool("Argo CD", "up"), tool("Grafana", "up"), tool("Flink", "degraded", "customer-decision-job: RESTARTING"), tool("Kafka browser", "up")]);
    expect(status.word).toBe("NEEDS ATTENTION");
    expect(status.title).toBe("1 tool needs attention: Flink · customer-decision-job: RESTARTING");
    expect(status.line).toMatch(/^3 of 4 tools are up\./);
  });

  it("counts several tools that need attention, and lists unknown ones too", () => {
    const status = platformStatus([tool("Argo CD", "degraded"), tool("Grafana", "down"), tool("Flink", "up"), tool("Kafka browser", "unknown", "not configured")]);
    expect(status.title).toBe("2 tools need attention");
    expect(status.line).toMatch(/^1 of 4 tools are up\./);
    expect(status.listed.map((t) => t.name)).toEqual(["Argo CD", "Grafana", "Kafka browser"]);
  });

  it("reads OK when the only tool not up is unknown, and lists it", () => {
    const status = platformStatus([...UP4.slice(0, 3), tool("Kafka browser", "unknown", "timed out")]);
    expect(status.word).toBe("OK");
    expect(status.listed.map((t) => t.reason)).toEqual(["timed out"]);
  });

  it("reads CHECKING while a check runs", () => {
    const status = platformStatus([tool("Argo CD", "up"), tool("Grafana", "up"), tool("Flink", "checking"), tool("Kafka browser", "checking")]);
    expect(status).toMatchObject({ word: "CHECKING", title: "Checking 2 of 4 tools…" });
    expect(status.line).toMatch(/^2 tools are up so far\./);
  });

  it("reads NOTHING TO CHECK with no tools", () => {
    expect(platformStatus([])).toMatchObject({ word: "NOTHING TO CHECK", title: "No tools to check" });
  });
});

describe("check time", () => {
  it("shows the oldest check, or Not checked", () => {
    expect(checkedText([80_000, 90_000], 100_000)).toBe("Checked 20 s ago");
    expect(checkedText([null], 100_000)).toBe("Not checked");
    expect(checkedText([], 100_000)).toBe("Not checked");
  });
});
