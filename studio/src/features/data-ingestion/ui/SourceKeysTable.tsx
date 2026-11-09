import type { ReactNode } from "react";
import { KeyRoundIcon } from "lucide-react";
import type { SourceKeyRow } from "@/features/data-health/model/sourceKeys";
import { formatDateTime } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable } from "@/shared/ui/v2/DataTable";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { NotAvailable, RegionEmpty } from "@/shared/ui/v2/states";

export function countLine(keys: readonly SourceKeyRow[]): string {
  const active = keys.filter((key) => key.status.kind === "active").length;
  return `${active} active · ${keys.length - active} revoked · active first`;
}

/**
 * DHL-FR-04: every source key, active first. A row holds the key's hint, never the key or its hash.
 * The page passes the revoke control and the empty state's create button, so this table never writes.
 */
export function SourceKeysTable({
  keys,
  zone,
  revoke,
  create,
}: {
  keys: readonly SourceKeyRow[];
  zone: TimeZone;
  revoke: (key: SourceKeyRow) => ReactNode;
  create: ReactNode;
}) {
  return (
    <SectionCard description={keys.length === 0 ? undefined : countLine(keys)} flush title="Source keys">
      <DataTable
        columns={[
          { id: "app", header: "Source (app id)", cell: (key) => <span className="font-medium font-mono">{key.appId}</span> },
          { id: "hint", header: "Key starts with", cell: (key) => <span className="font-mono text-muted-foreground">{key.hint}…</span> },
          { id: "creator", header: "Created by", cell: (key) => <span className="text-muted-foreground">{key.createdBy ?? "Not recorded"}</span> },
          {
            id: "created",
            header: "Created",
            cell: (key) => <time className="whitespace-nowrap text-muted-foreground">{formatDateTime(key.createdAt, zone)}</time>,
          },
          {
            id: "status",
            header: "Status",
            cell: (key) =>
              key.status.kind === "active" ? (
                <StatusBadge tone="success">Active</StatusBadge>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="neutral">Revoked</StatusBadge>
                  <time className="whitespace-nowrap text-muted-foreground text-xs">{formatDateTime(key.status.at, zone)}</time>
                </span>
              ),
          },
          {
            id: "health",
            header: "Health",
            // Decision 13: no reader backs per-source requests yet, so nothing is counted here.
            cell: () => <NotAvailable reason="Requests per source are not recorded yet." />,
          },
          { id: "actions", header: "Actions", cell: (key) => (key.status.kind === "active" ? revoke(key) : null) },
        ]}
        empty={
          <RegionEmpty
            action={create}
            icon={KeyRoundIcon}
            message="No source keys yet. Create one for each system that should send events through the API, like your order service."
          />
        }
        footer={
          keys.length === 0 ? undefined : (
            <p className="text-muted-foreground text-xs">
              Studio keeps only a fingerprint of each key and shows the full key once, when it is created. To replace a key, revoke it,
              then create a new one for the same source. A source has one active key at a time.
            </p>
          )
        }
        label="Source keys"
        rowKey={(key) => key.id}
        rows={keys}
      />
    </SectionCard>
  );
}
