import Link from "next/link";
import type { ReactNode } from "react";
import { EyeIcon, EyeOffIcon, FileTextIcon, KeyRoundIcon, LockIcon, ScrollTextIcon, ShieldCheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/shared/lib/format";
import { zoneLabel, type TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { ImportStatus } from "../imports/ImportStatus";
import {
  LOG_FILTERS,
  PII_ACTION_LABELS,
  shortCode,
  TOMBSTONE_STATE_LABELS,
  type AccessLogRow,
  type DeletionRequestRow,
  type LogFilter,
} from "../../model/privacyLog";
import { DeletePersonForm } from "./DeletePersonForm";

function Fact({ icon: Icon, title, children }: { icon: typeof EyeIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-tile border border-border bg-card p-4">
      <span className="flex items-center gap-1.5 font-semibold text-sm">
        <Icon aria-hidden className="size-3.5 text-primary" />
        {title}
      </span>
      <div className="text-muted-foreground text-xs">{children}</div>
    </div>
  );
}

export function PrivacyFacts() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Fact icon={EyeOffIcon} title="Masked for everyone">
        <span className="block font-mono text-foreground">n***@gmail.com</span>
        <span className="block font-mono text-foreground">+84 *** *** 678</span>
        <span className="mt-1 block">Other personal columns show ***.</span>
      </Fact>
      <Fact icon={EyeIcon} title="Reveal is logged">
        An admin&apos;s Reveal on a customer shows one value of one person. Studio writes the log row before it shows it.
      </Fact>
      <Fact icon={LockIcon} title="Encrypted at rest">
        Databases and delivered files are encrypted on disk. Files are kept 30 days.
      </Fact>
      <Fact icon={ScrollTextIcon} title="Log kept a year">
        Access log rows are removed after 365 days. No clear export exists.
      </Fact>
    </div>
  );
}

export function DeleteCard({ configured }: { configured: boolean }) {
  return (
    <SectionCard className="flex-[1_1_380px]" description="For a customer who asks to be forgotten." title="Delete a person's imported data">
      {configured ? (
        <DeletePersonForm />
      ) : (
        <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center" role="status">
          <span className="flex size-11 items-center justify-center rounded-tile bg-muted text-muted-foreground">
            <KeyRoundIcon aria-hidden className="size-5" />
          </span>
          <p className="font-semibold">Deleting a person is not configured.</p>
          <p className="max-w-sm text-muted-foreground text-sm">
            The deployment has no tombstone key, so Studio can&apos;t store a deletion request. Ask whoever runs the deployment to set it.
          </p>
        </div>
      )}
      <p className="mt-3 rounded-tile bg-muted px-3 py-2.5 text-xs">
        <b>Deleted:</b> their rows in every dataset, their imported values in conditions after the next nightly pass, and their key in
        earlier log rows. Files that hold them are rewritten. Later files with this key are rejected.
        <br />
        <b>Not deleted yet:</b> website and app tracking, journeys, and identity links.
      </p>
    </SectionCard>
  );
}

export function RequestsCard({ requests, zone }: { requests: DeletionRequestRow[]; zone: TimeZone }) {
  const columns: [Column<DeletionRequestRow>, ...Column<DeletionRequestRow>[]] = [
    { id: "when", header: "Requested", cell: (row) => formatDateTime(row.requestedAt, zone) },
    { id: "by", header: "By", cell: (row) => row.requestedBy ?? "Unknown" },
    {
      id: "person",
      header: "Person",
      cell: (row) => (
        <span>
          <span className="text-muted-foreground text-xs">Hidden · code</span> <span className="font-mono text-xs">{shortCode(row.tombstone)}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <ImportStatus label={TOMBSTONE_STATE_LABELS[row.state]} tone={row.state === "done" ? "ok" : "info"} />
          {row.state === "requested" && <span className="text-muted-foreground text-xs">Runs within 10 minutes</span>}
        </span>
      ),
    },
  ];
  return (
    <SectionCard className="flex-[1_1_520px]" description="Studio keeps only a one-way code of each key, never the key itself." flush title="Deletion requests">
      <DataTable
        columns={columns}
        empty={<RegionEmpty icon={ShieldCheckIcon} message="No one has asked to delete a person yet." />}
        label="Deletion requests"
        rowKey={(row) => row.tombstone}
        rows={requests}
      />
    </SectionCard>
  );
}

const FILTER_LABELS: Record<LogFilter, string> = { all: "All", ...PII_ACTION_LABELS };

function subjectCell(row: AccessLogRow): ReactNode {
  switch (row.subject.kind) {
    case "customer":
      return <span className="font-mono text-xs">{row.subject.customerKey}</span>;
    case "hidden":
      return (
        <span className="text-muted-foreground text-xs">
          {row.subject.code === null ? "Hidden · person deleted" : `Hidden · code ${row.subject.code}`}
        </span>
      );
    case "file":
      return <span className="font-mono text-xs">{row.subject.name}</span>;
    case "none":
      return "–";
    default: {
      const unhandled: never = row.subject;
      return unhandled;
    }
  }
}

export function AccessLogCard({
  log,
  counts,
  filter,
  zone,
}: {
  log: AccessLogRow[];
  counts: Record<LogFilter, number>;
  filter: LogFilter;
  zone: TimeZone;
}) {
  const columns: [Column<AccessLogRow>, ...Column<AccessLogRow>[]] = [
    { id: "when", header: "When", cell: (row) => <span className="whitespace-nowrap">{formatDateTime(row.at, zone)}</span> },
    { id: "who", header: "Who", cell: (row) => row.who },
    { id: "what", header: "What", cell: (row) => <span className="font-semibold">{PII_ACTION_LABELS[row.action]}</span> },
    { id: "subject", header: "Customer or file", cell: subjectCell },
    { id: "fields", header: "Fields", cell: (row) => <span className="font-mono text-xs">{row.fields.length === 0 ? "–" : row.fields.join(", ")}</span> },
    { id: "route", header: "Page", cell: (row) => <span className="font-mono text-xs">{row.route}</span> },
  ];
  return (
    <DataTable
      columns={columns}
      empty={<RegionEmpty icon={FileTextIcon} message="No one has seen a clear value or asked for a deletion yet." />}
      footer={
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>Showing {log.length} rows, newest first</span>
          <span className="ml-auto">50 per page · rows older than 365 days are removed</span>
        </div>
      }
      label="Access log"
      rowKey={(row) => row.id}
      rows={log}
      toolbar={
        <>
          <div className="mr-2">
            <h2 className="font-heading font-semibold text-[0.9375rem]">Access log</h2>
            <p className="text-muted-foreground text-xs">Every clear value someone saw, and every deletion request</p>
          </div>
          <nav aria-label="Filter the access log" className="flex flex-wrap gap-1.5">
            {LOG_FILTERS.map((option) => {
              const on = option === filter;
              return (
                <Link
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "border-primary/30 bg-primary/10 font-semibold text-primary" : "border-input bg-background",
                  )}
                  href={option === "all" ? "/v2/data/privacy" : `/v2/data/privacy?action=${option}`}
                  key={option}
                >
                  {FILTER_LABELS[option]}
                  <span className="font-heading text-muted-foreground tabular-nums">{counts[option]}</span>
                </Link>
              );
            })}
          </nav>
          <span className="ml-auto text-muted-foreground text-xs">{zoneLabel(zone)}</span>
        </>
      }
    />
  );
}
