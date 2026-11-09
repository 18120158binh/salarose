"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { DeadLetterCursor, DeadLetterPage } from "../model/deadLetterReader";
import { querySearch, windowPhrase, type DeadLetterQuery } from "../model/deadLetterQuery";
import type { DeadLetterRow } from "../model/deadLetters";
import { failureMessage, payloadSizeText, reasonLabel, reasonText, RECORD_LABELS, shortPayloadId } from "../model/deadLetterView";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty, RegionError, TableSkeleton } from "@/shared/ui/v2/states";
import { DeadLetterContentSheet, type RecordPosition } from "./DeadLetterContentSheet";

const BASE = "/v2/data/dead-letters";

type List =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; rows: DeadLetterRow[]; older: DeadLetterCursor | null; stoppedAtCap: boolean };

// DHL-FR-09: the browser keeps no copy. Every request skips the HTTP cache, and rows live only in
// this component's state.
async function fetchPage(search: string, cursor: DeadLetterCursor | null, signal: AbortSignal): Promise<DeadLetterPage | string> {
  const params = new URLSearchParams(search);
  if (cursor) params.set("older", JSON.stringify(cursor));
  const response = await fetch(`${BASE}/records?${params}`, { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  return response.ok ? (body as DeadLetterPage) : failureMessage(response.status, body);
}

function rowKey(row: DeadLetterRow): string {
  return `${row.partition}:${row.offset}`;
}

function droppedAtText(instant: number, zone: TimeZone): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "medium" }).format(instant);
}

function columns(zone: TimeZone): [Column<DeadLetterRow>, ...Column<DeadLetterRow>[]] {
  return [
    {
      id: "dropped",
      header: "Dropped at",
      cell: (row) => {
        if (row.record === "unreadable") return null;
        return row.droppedAt === null ? (
          <span className="text-muted-foreground">Unknown</span>
        ) : (
          <span className="font-heading tabular-nums">{droppedAtText(row.droppedAt, zone)}</span>
        );
      },
    },
    {
      id: "reason",
      header: "Why",
      cell: (row) => {
        if (row.record === "unreadable") {
          return (
            <span className="flex flex-col gap-0.5">
              <StatusBadge tone="warning">Unreadable record</StatusBadge>
              <span className="font-mono text-muted-foreground text-xs">
                partition {row.partition}, offset {row.offset}
              </span>
            </span>
          );
        }
        const label = reasonLabel(row);
        return (
          <span className="flex flex-col gap-0.5">
            {label && <span className="font-medium">{label}</span>}
            <span className="font-mono text-muted-foreground text-xs">{reasonText(row)}</span>
          </span>
        );
      },
    },
    { id: "record", header: "Record", cell: (row) => (row.record === "unreadable" ? null : RECORD_LABELS[row.record]) },
    {
      id: "detail",
      header: "Detail",
      cell: (row) => (row.record === "unreadable" || !row.detail ? null : <span className="font-mono text-xs">{row.detail}</span>),
    },
    {
      id: "payload",
      header: "Request id",
      cell: (row) =>
        row.record === "unreadable" ? null : (
          <span className="font-mono text-muted-foreground text-xs">{row.payloadId === null ? "none" : shortPayloadId(row.payloadId)}</span>
        ),
    },
    { id: "size", header: "Size", kind: "number", cell: payloadSizeText },
  ];
}

export interface DeadLetterBrowserProps {
  query: DeadLetterQuery;
  zone: TimeZone;
}

// DHL-FR-06 and DHL-FR-07: the newest 100 rows, Load older for the next 100, and one record's
// content at a time, fetched only when the admin opens it.
export function DeadLetterBrowser({ query, zone }: DeadLetterBrowserProps) {
  const [list, setList] = useState<List>({ status: "loading" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState<string | null>(null);
  const [opened, setOpened] = useState<RecordPosition | null>(null);
  const [attempt, setAttempt] = useState(0);
  const olderRequest = useRef<AbortController | null>(null);
  // A new server render passes an equal query in a new object, which must not reload page 1.
  const search = querySearch(query);

  useEffect(() => {
    const controller = new AbortController();
    fetchPage(search, null, controller.signal).then(
      (page) => setList(typeof page === "string" ? { status: "failed", message: page } : { status: "ready", ...page }),
      () => {
        if (!controller.signal.aborted) setList({ status: "failed", message: failureMessage(0, null) });
      },
    );
    return () => {
      controller.abort();
      olderRequest.current?.abort();
    };
  }, [search, attempt]);

  const retry = useCallback(() => {
    setList({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  if (list.status === "loading") return <TableSkeleton rows={8} />;
  if (list.status === "failed") {
    return (
      <div className="rounded-lg border border-border bg-card">
        <RegionError message={list.message} onRetry={retry} />
      </div>
    );
  }

  const loadOlder = async () => {
    if (!list.older) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    setOlderFailed(null);
    try {
      const page = await fetchPage(search, list.older, controller.signal);
      if (typeof page === "string") setOlderFailed(page);
      else setList({ status: "ready", rows: [...list.rows, ...page.rows], older: page.older, stoppedAtCap: page.stoppedAtCap });
    } catch {
      if (!controller.signal.aborted) setOlderFailed(failureMessage(0, null));
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  };

  const filtered = query.reason !== null || query.record !== null;
  const footer = (list.older || list.stoppedAtCap || olderFailed) && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm" role={olderFailed ? "alert" : undefined}>
        {olderFailed ?? (list.stoppedAtCap ? "Stopped after reading 10,000 records. Load older reads the next ones." : `Showing the newest ${list.rows.length} records ${windowPhrase(query.window)}.`)}
      </p>
      {list.older && (
        <Button disabled={loadingOlder} onClick={loadOlder} size="sm" variant="outline">
          {loadingOlder && <Spinner aria-hidden />}
          Load older
        </Button>
      )}
    </div>
  );

  return (
    <>
      <DataTable
        columns={columns(zone)}
        empty={
          <RegionEmpty
            icon={CircleCheckIcon}
            message={
              filtered
                ? `Nothing matches these filters ${windowPhrase(query.window)}.`
                : `Nothing was dropped ${windowPhrase(query.window)}. Every event that arrived could be used.`
            }
          />
        }
        footer={footer || undefined}
        label="Dropped data"
        rowActions={(row) => (
          <Button onClick={() => setOpened({ partition: row.partition, offset: row.offset })} size="sm" variant="ghost">
            Show content
          </Button>
        )}
        rowKey={rowKey}
        rows={list.rows}
      />
      <DeadLetterContentSheet key={opened ? `${opened.partition}:${opened.offset}` : "closed"} onClose={() => setOpened(null)} position={opened} />
    </>
  );
}
