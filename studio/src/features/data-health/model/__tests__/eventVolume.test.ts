import {
  lastSeenQuery,
  parseLastSeenRows,
  parseVolumeRows,
  summarizeEventVolume,
  volumeRowsQuery,
  type VolumeRow,
} from "../eventVolume";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 10:41:07 UTC, so the current hour started at 10:00.
const NOW = Date.UTC(2026, 10, 8, 10, 41, 7);
const THIS_HOUR = Date.UTC(2026, 10, 8, 10);

function row(eventName: string, bucketStart: number, outcome: string, count: number): VolumeRow {
  return { eventName, bucketStart, outcome, count };
}

describe("summarizeEventVolume", () => {
  const rows = [
    row("add_to_cart", THIS_HOUR, "accepted", 5),
    row("add_to_cart", THIS_HOUR - HOUR, "accepted", 7),
    row("add_to_cart", THIS_HOUR - 11 * HOUR, "accepted", 11),
    row("add_to_cart", THIS_HOUR, "schema_invalid", 2),
    row("add_to_cart", THIS_HOUR - 2 * DAY, "no_timestamp", 1),
    row("add_to_cart", THIS_HOUR - 2 * DAY, "accepted", 13),
    row("add_to_cart", THIS_HOUR - 6 * DAY - 23 * HOUR, "accepted", 17),
    row("add_to_cart", THIS_HOUR - 20 * DAY, "accepted", 19),
  ];
  const lastSeen = [{ eventName: "add_to_cart", lastSeenAt: NOW - 60_000 }];

  it("counts today from midnight in the time zone, by outcome (DHL-FR-18)", () => {
    const [volume] = summarizeEventVolume(["add_to_cart"], rows, lastSeen, "today", NOW, "UTC");

    expect(volume).toEqual(expect.objectContaining({
      eventName: "add_to_cart",
      accepted: 12,
      dropped: 2,
      droppedByReason: { schema_invalid: 2 },
      lastSeenAt: new Date(NOW - 60_000).toISOString(),
      arrival: "receiving",
    }));
  });

  it("starts today at Vietnam's midnight by default", () => {
    // 17:41 in Hanoi, so today began at 17:00 UTC the day before and holds the 23:00 UTC row.
    const [volume] = summarizeEventVolume(["add_to_cart"], rows, lastSeen, "today", NOW);

    expect(volume.accepted).toBe(23);
  });

  it("counts every reason in 7 and 30 days", () => {
    const [week] = summarizeEventVolume(["add_to_cart"], rows, lastSeen, "7d", NOW, "UTC");
    const [month] = summarizeEventVolume(["add_to_cart"], rows, lastSeen, "30d", NOW, "UTC");

    expect(week.accepted).toBe(36);
    expect(week.droppedByReason).toEqual({ schema_invalid: 2, no_timestamp: 1 });
    expect(month.accepted).toBe(72);
  });

  it("puts accepted events into 7 days that end with the current hour, oldest first", () => {
    const [volume] = summarizeEventVolume(["add_to_cart"], rows, lastSeen, "7d", NOW, "UTC");

    expect(volume.daily).toEqual([17, 0, 0, 0, 13, 0, 23]);
  });

  it("gives a name with no rows zeros and never, and keeps the order asked for", () => {
    const volumes = summarizeEventVolume(["wishlist_added", "add_to_cart"], rows, lastSeen, "today", NOW);

    expect(volumes.map((v) => v.eventName)).toEqual(["wishlist_added", "add_to_cart"]);
    expect(volumes[0]).toEqual({
      eventName: "wishlist_added",
      accepted: 0,
      dropped: 0,
      droppedByReason: {},
      daily: [0, 0, 0, 0, 0, 0, 0],
      lastSeenAt: null,
      arrival: "never",
    });
  });

  it("calls an event quiet after 7 days with nothing, and idle when seen this week but not in the window", () => {
    const seen = (ago: number) => [{ eventName: "price_drop", lastSeenAt: NOW - ago }];

    expect(summarizeEventVolume(["price_drop"], [], seen(8 * DAY), "today", NOW)[0].arrival).toBe("quiet");
    expect(summarizeEventVolume(["price_drop"], [], seen(3 * DAY), "today", NOW)[0].arrival).toBe("idle");
  });
});

describe("parsing rows", () => {
  it("reads Postgres rows and leaves out one that does not parse", () => {
    expect(parseVolumeRows([
      { event_name: "add_to_cart", bucket_start: new Date(THIS_HOUR), outcome: "accepted", count: "42" },
      { event_name: "add_to_cart", bucket_start: "not a time", outcome: "accepted", count: "1" },
      { event_name: "add_to_cart", bucket_start: new Date(THIS_HOUR), outcome: "accepted", count: "0" },
    ])).toEqual([row("add_to_cart", THIS_HOUR, "accepted", 42)]);
    expect(parseLastSeenRows([{ event_name: "add_to_cart", last_seen_at: new Date(NOW) }, { event_name: 1 }]))
      .toEqual([{ eventName: "add_to_cart", lastSeenAt: NOW }]);
  });

  it("reads back far enough for the 30-day window in any time zone", () => {
    const query = volumeRowsQuery(["add_to_cart"], NOW);

    expect(query.values).toEqual([["add_to_cart"], new Date(THIS_HOUR - 31 * DAY)]);
    expect(lastSeenQuery(["add_to_cart"]).values).toEqual([["add_to_cart"]]);
  });
});
