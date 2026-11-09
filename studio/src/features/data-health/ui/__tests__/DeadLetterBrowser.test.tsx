import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DeadLetterRow } from "../../model/deadLetters";
import { DEFAULT_QUERY } from "../../model/deadLetterQuery";
import type { TimeZone } from "@/shared/lib/time-range";
import { DeadLetterBrowser } from "../DeadLetterBrowser";

const ZONE = "UTC" as TimeZone;
const NOW = Date.UTC(2026, 10, 7, 10, 41, 7);
const EVENT = { eid: "e-3", product: { price: "12.50" } };

function row(offset: number): DeadLetterRow {
  return {
    partition: 0,
    offset,
    timestamp: NOW - offset,
    record: "event",
    eventName: "add_to_cart",
    reason: "schema_invalid",
    detail: "product.price not number",
    droppedAt: NOW - offset,
    payloadId: "3f9a07be55c1",
  };
}

const older = { partitions: [{ partition: 0, start: 0, before: 50 }] };

// jsdom has no Response. The browser reads only these three members.
function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();

beforeAll(() => {
  // The sheet's scroll area reads animations, which jsdom does not implement.
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async (url) => {
    if (url.includes("/content?")) return json({ content: { record: "event", event: EVENT } });
    if (url.includes("older=")) return json({ rows: Array.from({ length: 50 }, (_, i) => row(149 - i)), older: null, stoppedAtCap: false });
    return json({ rows: Array.from({ length: 100 }, (_, i) => row(i)), older, stoppedAtCap: false });
  });
});

// Counts rows by the button text: a role query over 150 rows is slow enough to time out under load.
function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

describe("dead-letter browser", () => {
  it("shows the newest 100, then the other 50 with Load older (DHL-FR-06)", async () => {
    render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);

    expect(await screen.findAllByText("Show content")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));

    await waitFor(() => expect(screen.getAllByText("Show content")).toHaveLength(150));
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    const olderUrl = new URL(urls()[1], "https://studio.example.com");
    expect(olderUrl.pathname).toBe("/v2/data/dead-letters/records");
    expect(JSON.parse(olderUrl.searchParams.get("older")!)).toEqual(older);
  });

  it("keeps the older rows when the page renders again with the same query", async () => {
    const { rerender } = render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);
    expect(await screen.findAllByText("Show content")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(screen.getAllByText("Show content")).toHaveLength(150));

    rerender(<DeadLetterBrowser query={{ ...DEFAULT_QUERY }} zone={ZONE} />);
    await act(async () => undefined);

    expect(screen.getAllByText("Show content")).toHaveLength(150);
    expect(urls()).toHaveLength(2);
  });

  it("shows a row's drop time, reason, record type, detail, and short payload id", async () => {
    render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);

    const first = (await screen.findAllByRole("row"))[1];
    expect(within(first).getByText("Didn't fit Strict rules")).toBeInTheDocument();
    expect(within(first).getByText("schema_invalid")).toBeInTheDocument();
    expect(within(first).getByText("Event")).toBeInTheDocument();
    expect(within(first).getByText("product.price not number")).toBeInTheDocument();
    expect(within(first).getByText("3f9a…c1")).toBeInTheDocument();
    expect(within(first).getByText("Nov 7, 2026, 10:41:07 AM")).toBeInTheDocument();
  });

  it("fetches no content until the admin opens one record, then only that record's (DHL-FR-07)", async () => {
    render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);
    const buttons = await screen.findAllByRole("button", { name: "Show content" });

    expect(urls().some((url) => url.includes("/content"))).toBe(false);
    expect(document.body.textContent).not.toContain("12.50");

    await act(async () => fireEvent.click(buttons[3]));

    expect(await screen.findByText(/"12.50"/)).toBeInTheDocument();
    const contentUrls = urls().filter((url) => url.includes("/content"));
    expect(contentUrls).toEqual(["/v2/data/dead-letters/content?partition=0&offset=3"]);
  });

  it("asks the browser to store no response (DHL-FR-09)", async () => {
    render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);
    const buttons = await screen.findAllByRole("button", { name: "Show content" });
    await act(async () => fireEvent.click(buttons[0]));
    await screen.findByText(/"12.50"/);

    for (const [, init] of fetchMock.mock.calls) expect(init?.cache).toBe("no-store");
  });

  it("names the reason the topic could not be read, and tries again", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "topic not found" }, 503));
    render(<DeadLetterBrowser query={DEFAULT_QUERY} zone={ZONE} />);

    expect(await screen.findByText("Dropped data could not load: topic not found.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findAllByText("Show content")).toHaveLength(100);
  });

  it("says when it stopped at the read cap", async () => {
    fetchMock.mockResolvedValueOnce(json({ rows: [row(1)], older, stoppedAtCap: true }));
    render(<DeadLetterBrowser query={{ ...DEFAULT_QUERY, reason: "no_timestamp" }} zone={ZONE} />);

    expect(await screen.findByText(/Stopped after reading 10,000 records/)).toBeInTheDocument();
    expect(urls()[0]).toBe("/v2/data/dead-letters/records?reason=no_timestamp");
  });

  it("says the window is empty", async () => {
    fetchMock.mockResolvedValueOnce(json({ rows: [], older: null, stoppedAtCap: false }));
    render(<DeadLetterBrowser query={{ ...DEFAULT_QUERY, window: "today" }} zone={ZONE} />);

    expect(await screen.findByText("Nothing was dropped today. Every event that arrived could be used.")).toBeInTheDocument();
  });
});
