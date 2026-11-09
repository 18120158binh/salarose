import type { UserEventPage, UserEventPageCursor, UserEventSummary } from "@/app/types";

// The events the list shows: the first page from the server, then the pages loaded with Load
// more. firstPageCount is how many of the events came from the first page.
export interface EventListState {
  events: UserEventSummary[];
  nextCursor: UserEventPageCursor | null;
  firstPageCount: number;
}

export function eventListFromPage(page: UserEventPage): EventListState {
  return { events: page.events, nextCursor: page.nextCursor, firstPageCount: page.events.length };
}

export function appendEventPage(list: EventListState, page: UserEventPage): EventListState {
  const shown = new Set(list.events.map((event) => event.id));
  return {
    ...list,
    events: [...list.events, ...page.events.filter((event) => !shown.has(event.id))],
    nextCursor: page.nextCursor,
  };
}

// A refresh sends a new first page. The pages loaded after it stay, with their cursor, so the
// list does not shrink. An event that the new first page no longer holds, because a create pushed
// it off, stays too. When the first page has no next page, it holds the whole catalog.
export function mergeRefreshedFirstPage(list: EventListState, firstPage: UserEventPage): EventListState {
  const loadedMore = list.events.length > list.firstPageCount;
  if (!loadedMore || firstPage.nextCursor === null) return eventListFromPage(firstPage);
  const onFirstPage = new Set(firstPage.events.map((event) => event.id));
  return {
    events: [...firstPage.events, ...list.events.filter((event) => !onFirstPage.has(event.id))],
    nextCursor: list.nextCursor,
    firstPageCount: firstPage.events.length,
  };
}

export function removeEvent(list: EventListState, eventId: string): EventListState {
  const index = list.events.findIndex((event) => event.id === eventId);
  if (index < 0) return list;
  return {
    ...list,
    events: list.events.filter((event) => event.id !== eventId),
    firstPageCount: index < list.firstPageCount ? list.firstPageCount - 1 : list.firstPageCount,
  };
}

// Shows a created event that sorts into the pages loaded with Load more, which the refreshed
// first page does not reach. The server orders by its collation, so the place is close, not exact.
// With only the first page loaded, the refresh or Load more brings the event.
export function addCreatedEvent(list: EventListState, created: UserEventSummary): EventListState {
  if (list.events.length <= list.firstPageCount || list.events.some((event) => event.id === created.id)) {
    return list;
  }
  const loaded = list.events.slice(list.firstPageCount);
  const before = loaded.findIndex((event) => event.name.localeCompare(created.name) > 0);
  const index = list.firstPageCount + (before < 0 ? loaded.length : before);
  return { ...list, events: [...list.events.slice(0, index), created, ...list.events.slice(index)] };
}
