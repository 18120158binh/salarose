import type { UserEventPage, UserEventSummary } from "@/app/types";
import { addCreatedEvent, appendEventPage, eventListFromPage, mergeRefreshedFirstPage, removeEvent } from "../eventList";

const event = (name: string): UserEventSummary => ({
  id: `ue_${name}`,
  name,
  label: name,
  fieldCount: 0,
  enforceSchema: false,
  eventKind: { kind: "person" },
  status: "active",
});
const page = (names: string[], nextAfter: string | null): UserEventPage => ({
  events: names.map(event),
  nextCursor: nextAfter ? { eventName: nextAfter, id: `ue_${nextAfter}` } : null,
});
const names = (list: { events: UserEventSummary[] }) => list.events.map((e) => e.name);

describe("refreshing the event list (CAT-KI-11)", () => {
  const loaded = appendEventPage(eventListFromPage(page(["a", "b"], "b")), page(["c", "d"], "d"));

  it("keeps the events loaded with Load more and their cursor", () => {
    const refreshed = mergeRefreshedFirstPage(loaded, page(["a", "b"], "b"));

    expect(names(refreshed)).toEqual(["a", "b", "c", "d"]);
    expect(refreshed.nextCursor).toEqual({ eventName: "d", id: "ue_d" });
  });

  it("keeps an event that a create pushed off the first page", () => {
    const refreshed = mergeRefreshedFirstPage(loaded, page(["a", "aa"], "aa"));
    expect(names(refreshed)).toEqual(["a", "aa", "b", "c", "d"]);
  });

  it("takes the first page as the whole list when the catalog fits on it", () => {
    const refreshed = mergeRefreshedFirstPage(loaded, page(["a", "c"], null));
    expect(names(refreshed)).toEqual(["a", "c"]);
    expect(refreshed.nextCursor).toBeNull();
  });

  it("takes the new first page and its cursor when nothing more was loaded", () => {
    const refreshed = mergeRefreshedFirstPage(eventListFromPage(page(["a", "b"], "b")), page(["a", "aa"], "aa"));
    expect(names(refreshed)).toEqual(["a", "aa"]);
    expect(refreshed.nextCursor).toEqual({ eventName: "aa", id: "ue_aa" });
  });

  it("skips events that a page repeats", () => {
    expect(names(appendEventPage(loaded, page(["d", "e"], null)))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("removes a deleted event from any page", () => {
    expect(names(removeEvent(loaded, "ue_c"))).toEqual(["a", "b", "d"]);
  });

  it("shows a created event among the loaded pages, in name order", () => {
    expect(names(addCreatedEvent(loaded, event("cc")))).toEqual(["a", "b", "c", "cc", "d"]);
  });

  it("leaves a created event to Load more when only the first page is loaded", () => {
    expect(names(addCreatedEvent(eventListFromPage(page(["a", "b"], "b")), event("c")))).toEqual(["a", "b"]);
  });
});
