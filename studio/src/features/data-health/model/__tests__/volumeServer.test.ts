/** @jest-environment node */
import { loadEventHealth, loadEventVolumes } from "../volumeServer";
import { parseTimeZone } from "../../../../shared/lib/time-range";

jest.mock("server-only", () => ({}));
jest.mock("../../../../widgets/v2-shell/model/viewer", () => ({ requireViewer: async () => ({ id: "u1" }) }));

// Each read answers in order: catalog names (health only), volume rows, last seen.
const mockAnswers: Record<string, unknown>[][] = [];
jest.mock("@/lib/db", () => ({
  readOnly: async (_timeout: number, body: (run: () => Promise<Record<string, unknown>[]>) => Promise<unknown>) =>
    body(async () => mockAnswers.shift() ?? []),
}));

// 12:00 UTC on 8 Nov: midnight was 05:00 UTC in New York and 17:00 UTC the day before in Vietnam.
const NOW = Date.parse("2026-11-08T12:00:00Z");
const ROWS = [
  { event_name: "add_to_cart", bucket_start: "2026-11-07T18:00:00Z", outcome: "accepted", count: 1 },
  { event_name: "add_to_cart", bucket_start: "2026-11-08T06:00:00Z", outcome: "accepted", count: 1 },
];
const NEW_YORK = parseTimeZone("America/New_York");

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  mockAnswers.length = 0;
});

afterEach(() => jest.restoreAllMocks());

describe("volume loaders count Today in the viewer's zone (SHL-FR-15)", () => {
  it("starts Today at New York's midnight for a New York viewer", async () => {
    mockAnswers.push(ROWS, []);
    const [volume] = await loadEventVolumes(["add_to_cart"], "today", NEW_YORK);
    expect(volume.accepted).toBe(1);
  });

  it("starts Today at Vietnam's midnight for a Vietnam viewer", async () => {
    mockAnswers.push(ROWS, []);
    const [volume] = await loadEventVolumes(["add_to_cart"], "today", parseTimeZone("Asia/Ho_Chi_Minh"));
    expect(volume.accepted).toBe(2);
  });

  it("gives the health summary the same zone", async () => {
    mockAnswers.push([{ id: 1, event_name: "add_to_cart", label: "Added to cart" }], ROWS, []);
    const health = await loadEventHealth("today", NEW_YORK);
    expect(JSON.stringify(health)).toContain('"accepted":1');
  });
});
