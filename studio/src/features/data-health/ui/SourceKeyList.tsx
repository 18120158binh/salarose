import type { ReactNode } from "react";
import { KeyRoundIcon } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty } from "@/shared/ui/v2/states";
import type { SourceKeyRow } from "../model/sourceKeys";

type RowAction = (key: SourceKeyRow) => ReactNode;

function columns(zone: TimeZone, action: RowAction | undefined): readonly [Column<SourceKeyRow>, ...Column<SourceKeyRow>[]] {
  const base: [Column<SourceKeyRow>, ...Column<SourceKeyRow>[]] = [
    { id: "app", header: "App id", cell: (key) => <span className="font-medium font-mono">{key.appId}</span> },
    { id: "hint", header: "Key hint", cell: (key) => <span className="font-mono text-muted-foreground">{key.hint}…</span> },
    {
      id: "creator",
      header: "Created by",
      cell: (key) => <span className="text-muted-foreground">{key.createdBy ?? "Not recorded"}</span>,
    },
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
  ];
  if (action === undefined) return base;
  return [...base, { id: "actions", header: "Actions", cell: action }];
}

/**
 * DHL-FR-04: every source key, active first. A row holds the key's hint, never the key or its hash.
 * The page passes the revoke control as the row action, so this list never writes.
 */
export function SourceKeyList({ keys, zone, action }: { keys: readonly SourceKeyRow[]; zone: TimeZone; action?: RowAction }) {
  return (
    <DataTable
      columns={columns(zone, action)}
      empty={<RegionEmpty icon={KeyRoundIcon} message="No source keys yet." />}
      label="Source keys"
      rowKey={(key) => key.id}
      rows={keys}
    />
  );
}
