/** @jest-environment node */
import type { Health } from "../health";
import { createHealthCache } from "../healthCache";
import type { HealthCheck } from "../tools";

const GRAFANA: HealthCheck = { kind: "grafana", url: "http://grafana" };
const UP: Health = { status: "up", reason: "healthy" };

function setup() {
  let clock = 0;
  const check = jest.fn(async () => UP);
  const health = createHealthCache(check, () => clock);
  return { health, check, advance: (ms: number) => (clock += ms) };
}

describe("health cache", () => {
  it("does not call a tool again within 15 seconds", async () => {
    const { health, check, advance } = setup();

    await health("grafana", GRAFANA);
    advance(14_999);
    expect(await health("grafana", GRAFANA)).toEqual(UP);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("calls the tool again once 15 seconds have passed", async () => {
    const { health, check, advance } = setup();

    await health("grafana", GRAFANA);
    advance(15_000);
    await health("grafana", GRAFANA);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shares one call among concurrent requests", async () => {
    const { health, check } = setup();

    const results = await Promise.all([health("grafana", GRAFANA), health("grafana", GRAFANA), health("grafana", GRAFANA)]);
    expect(results).toEqual([UP, UP, UP]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks each tool on its own", async () => {
    const { health, check } = setup();

    await health("grafana", GRAFANA);
    await health("argocd", { kind: "argocd", url: "http://argocd" });
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe("check time", () => {
  it("is the start of the check it reuses, and null before any check (PCN-FR-12)", async () => {
    const { health, advance } = setup();

    expect(health.checkedAt("grafana")).toBeNull();
    advance(1_000);
    await health("grafana", GRAFANA);
    advance(5_000);
    await health("grafana", GRAFANA);
    expect(health.checkedAt("grafana")).toBe(1_000);
  });
});
