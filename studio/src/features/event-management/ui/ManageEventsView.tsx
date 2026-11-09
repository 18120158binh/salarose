"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  UserEventFieldDef,
  UserEventPage,
  UserEventSummary,
} from "@/app/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addCreatedEvent,
  appendEventPage,
  eventListFromPage,
  mergeRefreshedFirstPage,
  removeEvent,
} from "@/features/event-management/model/eventList";
import { eventDeletionWarning } from "@/features/event-management/model/eventDeletion";
import { eventItemKey } from "@/features/event-management/model/eventKindDraft";
import { CreateEventDialog } from "@/features/event-management/ui/CreateEventDialog";
import { EditEventDialog, type EventAttributePaths } from "@/features/event-management/ui/EditEventDialog";
import { EventAttributesPanel } from "@/features/event-management/ui/EventAttributesPanel";
import { EventKindBadge } from "@/features/event-management/ui/EventKindFields";
import { EventSchemaGateSwitch } from "@/features/event-management/ui/EventSchemaGateSwitch";
import { EventStatusSwitch } from "@/features/event-management/ui/EventStatusSwitch";
import { callServerAction } from "@/shared/lib/serverAction";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  AlertCircle
} from "lucide-react";
import {
  deleteUserEventAction,
  getUserEventUsageAction,
  getUserEventFieldsAction,
  getUserEventSummariesPageAction,
} from "@/app/actions";

interface ManageEventsViewProps {
  initialPage: UserEventPage;
}

export default function ManageEventsView({
  initialPage,
}: ManageEventsViewProps) {
  const router = useRouter();
  const [list, setList] = useState(() => eventListFromPage(initialPage));
  const renderedFirstPage = useRef(initialPage);
  const [fieldsByEventId, setFieldsByEventId] = useState<
    Record<string, UserEventFieldDef[]>
  >({});
  const [loadingEventIds, setLoadingEventIds] = useState<Set<string>>(
    new Set(),
  );
  const [eventLoadErrors, setEventLoadErrors] = useState<
    Record<string, string>
  >({});
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [editingEvent, setEditingEvent] = useState<UserEventSummary | null>(null);
  const events = list.events;
  const nextCursor = list.nextCursor;

  // router.refresh() after a change sends a new first page. Merge it, so the pages loaded with
  // Load more and their cached attributes stay.
  useEffect(() => {
    if (renderedFirstPage.current === initialPage) return;
    renderedFirstPage.current = initialPage;
    setList((current) => mergeRefreshedFirstPage(current, initialPage));
  }, [initialPage]);

  const loadEventFields = async (eventId: string) => {
    setLoadingEventIds((currentIds) => new Set(currentIds).add(eventId));
    setEventLoadErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[eventId];
      return nextErrors;
    });

    try {
      const result = await callServerAction(() => getUserEventFieldsAction(eventId));
      if (result.error !== undefined || !("fields" in result) || !result.fields) {
        const message = result.error ?? "Failed to load event attributes.";
        setEventLoadErrors((currentErrors) => ({ ...currentErrors, [eventId]: message }));
        return;
      }
      const fields = result.fields;
      setFieldsByEventId((currentFields) => ({ ...currentFields, [eventId]: fields }));
      setList((current) => ({
        ...current,
        events: current.events.map((event) =>
          event.id === eventId ? { ...event, fieldCount: fields.length } : event,
        ),
      }));
    } finally {
      setLoadingEventIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(eventId);
        return nextIds;
      });
    }
  };

  const ensureEventFields = (event: UserEventSummary) => {
    if (Object.hasOwn(fieldsByEventId, event.id)) return;
    if (event.fieldCount === 0) {
      setFieldsByEventId((currentFields) => ({
        ...currentFields,
        [event.id]: [],
      }));
    } else if (!loadingEventIds.has(event.id)) {
      void loadEventFields(event.id);
    }
  };

  const toggleExpand = (event: UserEventSummary) => {
    const next = new Set(expandedEvents);
    if (next.has(event.id)) {
      next.delete(event.id);
    } else {
      next.add(event.id);
      ensureEventFields(event);
    }
    setExpandedEvents(next);
  };

  // A person event picks its item key from its attributes, so the edit dialog needs them.
  const startEditing = (event: UserEventSummary) => {
    setEditingEvent(event);
    if (eventItemKey(event.eventKind) === null) ensureEventFields(event);
  };

  const attributePathsOf = (eventId: string): EventAttributePaths => {
    const fields = fieldsByEventId[eventId];
    if (fields) return { status: "loaded", paths: fields.map((field) => field.value) };
    const error = eventLoadErrors[eventId];
    if (error && !loadingEventIds.has(eventId)) return { status: "failed", error };
    return { status: "loading" };
  };

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    setLoadMoreError("");
    try {
      const result = await callServerAction(() => getUserEventSummariesPageAction(nextCursor));
      if (result.error !== undefined || !("page" in result) || !result.page) {
        setLoadMoreError(result.error ?? "Failed to load more events.");
        return;
      }
      const page = result.page;
      setList((current) => appendEventPage(current, page));
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleCreated = (event: UserEventSummary) => {
    setList((current) => addCreatedEvent(current, event));
    router.refresh();
  };

  const handleDeleteEvent = async (event: UserEventSummary) => {
    const usageRes = await callServerAction(() => getUserEventUsageAction(event.id));
    if (usageRes.error !== undefined || !("usage" in usageRes) || !usageRes.usage) {
      alert(`Failed to delete event: ${usageRes.error}`);
      return;
    }
    const usage = usageRes.usage;
    if (confirm(eventDeletionWarning(event.label, usage))) {
      const res = await callServerAction(() => deleteUserEventAction(event.id));
      if (res.error !== undefined) {
        alert(`Failed to delete event: ${res.error}`);
      } else {
        setList((current) => removeEvent(current, event.id));
        router.refresh();
      }
    }
  };

  const handleEventChanged = (eventId: string, changes: Partial<UserEventSummary>) => {
    setList((current) => ({
      ...current,
      events: current.events.map((event) => (event.id === eventId ? { ...event, ...changes } : event)),
    }));
  };

  const handleEventSaved = (eventId: string, changes: Pick<UserEventSummary, "label" | "description" | "eventKind">) => {
    handleEventChanged(eventId, changes);
    setEditingEvent(null);
    router.refresh();
  };

  const handleRequiredChanged = (eventId: string, fieldPath: string, required: boolean) => {
    setFieldsByEventId((current) => ({
      ...current,
      [eventId]: (current[eventId] ?? []).map((field) =>
        field.value === fieldPath ? { ...field, required } : field,
      ),
    }));
  };

  const handleSchemaGateChange = (eventId: string, enforceSchema: boolean) => {
    setList((current) => ({
      ...current,
      events: current.events.map((event) =>
        event.id === eventId ? { ...event, enforceSchema } : event,
      ),
    }));
  };

  return (
    <div>
      <div className="mb-6 flex justify-between items-start text-zinc-900">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Event Definitions</h2>
          <p className="text-xs text-zinc-500 mt-1">
            Manage custom event schemas and attributes for tracking user behavior.
          </p>
        </div>

        <CreateEventDialog onCreated={handleCreated} />
      </div>

      <EditEventDialog
        attributePaths={editingEvent ? attributePathsOf(editingEvent.id) : { status: "loading" }}
        event={editingEvent}
        onClose={() => setEditingEvent(null)}
        onRetryAttributePaths={() => {
          if (editingEvent) void loadEventFields(editingEvent.id);
        }}
        onSaved={handleEventSaved}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12"></TableHead>
                <TableHead className="ps-4">Event Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Custom Fields</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Schema gate</TableHead>
                <TableHead className="text-right pe-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="w-8 h-8 text-muted" />
                      <p>No events defined yet.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                events.map((event) => {
                  const isExpanded = expandedEvents.has(event.id);
                  const eventFields = fieldsByEventId[event.id];
                  const areFieldsLoaded = eventFields !== undefined;
                  const isLoadingFields = loadingEventIds.has(event.id);
                  const fieldLoadError = eventLoadErrors[event.id];
                  const itemKey = eventItemKey(event.eventKind);
                  return (
                    <React.Fragment key={event.id}>
                      <TableRow className={isExpanded ? "bg-muted/30" : ""}>
                        <TableCell className="w-12 text-center">
                          <Button 
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${event.label}`}
                            variant="ghost" 
                            size="icon" 
                            className="h-6 w-6" 
                            onClick={() => toggleExpand(event)}
                          >
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                        </TableCell>
                        <TableCell className="font-semibold text-foreground">
                          {event.label}
                        </TableCell>
                        <TableCell>
                          <EventKindBadge eventKind={event.eventKind} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[250px] truncate">
                          {event.description || <span className="italic text-muted-foreground/50">No description</span>}
                          <div className="text-[10px] font-mono mt-1 text-muted-foreground/70">ID: {event.name}</div>
                          {itemKey !== null && (
                            <div className="text-[10px] font-mono text-muted-foreground/70">Item key: {itemKey}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{event.fieldCount} attributes</Badge>
                        </TableCell>
                        <TableCell>
                          <EventStatusSwitch
                            eventId={event.id}
                            eventLabel={event.label}
                            onChange={(status) => handleEventChanged(event.id, { status })}
                            status={event.status}
                          />
                        </TableCell>
                        <TableCell>
                          <EventSchemaGateSwitch
                            enforced={event.enforceSchema}
                            eventId={event.id}
                            eventLabel={event.label}
                            key={`${event.id}:${event.enforceSchema}`}
                            onChange={(enforced) =>
                              handleSchemaGateChange(event.id, enforced)
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            aria-label={`Edit ${event.label}`}
                            onClick={() => startEditing(event)}
                            size="icon"
                            variant="ghost"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button 
                            aria-label={`Delete ${event.label}`}
                            variant="ghost" 
                            size="icon" 
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDeleteEvent(event)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      
                      {isExpanded && !areFieldsLoaded && (
                        <TableRow className="bg-muted/10 border-b-0">
                          <TableCell colSpan={8} className="p-0 border-b-0">
                            <div className="bg-accent/20 p-4 ps-14">
                              {fieldLoadError && !isLoadingFields ? (
                                <div
                                  className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-background p-3"
                                  role="alert"
                                >
                                  <p className="text-xs text-destructive">
                                    {fieldLoadError}
                                  </p>
                                  <Button
                                    onClick={() => void loadEventFields(event.id)}
                                    size="xs"
                                    type="button"
                                    variant="outline"
                                  >
                                    Retry
                                  </Button>
                                </div>
                              ) : (
                                <div
                                  aria-label={`Loading attributes for ${event.label}`}
                                  className="space-y-2 rounded-lg border bg-background p-3"
                                  role="status"
                                >
                                  <Skeleton className="h-4 w-36" />
                                  <Skeleton className="h-8 w-full" />
                                  <Skeleton className="h-8 w-full" />
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}

                      {isExpanded && areFieldsLoaded && (
                        <TableRow className="bg-muted/10 border-b-0">
                          <TableCell colSpan={8} className="p-0 border-b-0">
                            <div className="bg-accent/20 p-4 ps-14">
                              <EventAttributesPanel
                                eventId={event.id}
                                fields={eventFields}
                                itemKey={itemKey}
                                onReload={() => loadEventFields(event.id)}
                                onRequiredChanged={(fieldPath, required) =>
                                  handleRequiredChanged(event.id, fieldPath, required)
                                }
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
          {(nextCursor || loadMoreError) && (
            <div className="flex flex-col items-center gap-2 border-t p-3">
              {loadMoreError && (
                <p className="text-xs text-destructive" role="alert">
                  {loadMoreError}
                </p>
              )}
              {nextCursor && (
                <Button
                  loading={isLoadingMore}
                  onClick={() => void handleLoadMore()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isLoadingMore ? "Loading events..." : "Load more events"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
