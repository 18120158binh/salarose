"use client";

import type { ReactNode } from "react";
import { DownloadIcon, TriangleAlertIcon, CircleXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCount, formatDateTime, formatDuration } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { SideSheet } from "@/shared/ui/v2/SideSheet";
import { NotAvailable } from "@/shared/ui/v2/states";
import { RUN_STATE_LABELS } from "../../model/domain";
import { fileName, formatBytes, formatLabel, runActionsOf, runDuration, senderOf, type ImportRun } from "../../model/imports";
import { approveRunAction, discardRunAction } from "../../model/importsActions";
import { ActionButton } from "./ActionButton";
import { inConditionsFrom } from "./runText";

// The sample rows and the rejects file live in the drop zone, which studio cannot read yet.
const NO_DROP_ZONE = "Studio can't read the drop zone yet.";

function Tile({ label, children, detail }: { label: string; children: ReactNode; detail?: string }) {
  return (
    <div className="flex flex-col rounded-tile border border-border px-3 py-2.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
      {detail && <span className="text-muted-foreground text-xs">{detail}</span>}
    </div>
  );
}

function Count({ value }: { value: number | null }) {
  return value === null ? (
    <span className="font-medium text-muted-foreground text-sm">Not available</span>
  ) : (
    <span className="font-heading font-semibold text-xl tabular-nums">{formatCount(value)}</span>
  );
}

function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function RunDetailSheet({ run, admin, zone, onClose }: { run: ImportRun | null; admin: boolean; zone: TimeZone; onClose: () => void }) {
  return (
    <SideSheet
      description={run ? `${run.dataset.displayName} · ${RUN_STATE_LABELS[run.state].label}` : undefined}
      onOpenChange={(open) => !open && onClose()}
      open={run !== null}
      size="form"
      title={run ? fileName(run) : "File"}
    >
      {run && <RunDetail admin={admin} run={run} zone={zone} />}
    </SideSheet>
  );
}

function RunDetail({ run, admin, zone }: { run: ImportRun; admin: boolean; zone: TimeZone }) {
  const sender = senderOf(run);
  const took = runDuration(run);
  const actions = runActionsOf(run);
  const { counts } = run;
  const dropped = counts.emailsDropped !== null || counts.phonesDropped !== null ? (counts.emailsDropped ?? 0) + (counts.phonesDropped ?? 0) : null;
  const format = formatLabel(run.format);
  const maxReason = counts.rejectedByReason[0]?.count ?? 0;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {run.state === "quarantined" && (
        <div className="flex gap-2.5 rounded-tile border border-warning/40 px-3.5 py-3" role="status">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <b className="text-warning">Held for review. Nothing was stored.</b> {run.reason ?? ""} Later {run.dataset.displayName} files wait
            until an admin decides.
          </p>
        </div>
      )}
      {run.state === "failed" && (
        <div className="flex gap-2.5 rounded-tile border border-destructive/40 px-3.5 py-3" role="status">
          <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>
            <b className="text-destructive">Failed. Nothing was stored.</b> {run.reason ?? ""}
          </p>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground text-xs">Sent by</dt>
          <dd>
            {sender.by} <span className="text-muted-foreground text-xs">{sender.kind}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Checked against</dt>
          <dd>
            {run.dataset.displayName} version {run.version}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Received</dt>
          <dd>{formatDateTime(run.createdAt, zone)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Format and size</dt>
          <dd>{format === null ? "–" : `${format}${run.byteSize === null ? "" : ` · ${formatBytes(run.byteSize)}`}`}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Took</dt>
          <dd>{took === null ? "–" : formatDuration(took)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">In conditions from</dt>
          <dd>{inConditionsFrom(run, zone)}</dd>
        </div>
      </dl>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile label="Rows read">
          <Count value={counts.rowsRead} />
        </Tile>
        <Tile
          detail={counts.rejected !== null && counts.rowsRead ? percent(counts.rejected, counts.rowsRead) : undefined}
          label="Rejected"
        >
          <Count value={counts.rejected} />
        </Tile>
        <Tile label="Customer key match">
          {counts.matchRate === null ? (
            <span className="font-medium text-muted-foreground text-sm">Not available</span>
          ) : (
            <span className="font-heading font-semibold text-xl tabular-nums">{Math.round(counts.matchRate * 100)}%</span>
          )}
        </Tile>
        <Tile
          detail={dropped === null ? undefined : `${formatCount(counts.phonesDropped ?? 0)} phones · ${formatCount(counts.emailsDropped ?? 0)} emails`}
          label="Contacts dropped"
        >
          <Count value={dropped} />
        </Tile>
      </div>

      {counts.rejectedByReason.length > 0 && (
        <section>
          <h3 className="mb-1.5 font-semibold text-[0.8125rem]">Why rows were rejected</h3>
          <ul className="flex flex-col gap-1.5">
            {counts.rejectedByReason.map((entry) => (
              <li className="flex items-center gap-2" key={entry.reason}>
                <span className="flex-1 font-mono text-xs">{entry.reason}</span>
                <span aria-hidden className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-info" style={{ width: `${maxReason === 0 ? 0 : (entry.count / maxReason) * 100}%` }} />
                </span>
                <span className="w-14 text-right font-heading tabular-nums">{formatCount(entry.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1.5 font-semibold text-[0.8125rem]">
          Sample rejected rows <span className="font-normal text-muted-foreground text-xs">personal data masked</span>
        </h3>
        <div className="rounded-tile border border-border px-3 py-2.5">
          <NotAvailable reason={`${NO_DROP_ZONE} The sample rows show here once it can.`} />
        </div>
      </section>

      {admin ? (
        <div className="flex flex-col gap-3 border-border border-t pt-3.5">
          {actions.approve && (
            <div className="flex items-start gap-3">
              <ActionButton
                doneTitle={`${fileName(run)} is approved and will apply`}
                failedTitle="The file was not approved."
                run={() => approveRunAction(run.id)}
                size="default"
                variant="default"
              >
                Approve and store
              </ActionButton>
              <p>Stores the good rows without the reject, size, and row limit checks. A full file removes stored customers it leaves out, except rows uploaded in Studio.</p>
            </div>
          )}
          {actions.discard && (
            <div className="flex items-start gap-3">
              <ActionButton
                doneTitle={`${fileName(run)} is discarded`}
                failedTitle="The file was not discarded."
                run={() => discardRunAction(run.id)}
                size="default"
                variant="destructive-outline"
              >
                Discard file
              </ActionButton>
              <p>Stores nothing and lets the next {run.dataset.displayName} file apply.</p>
            </div>
          )}
          <div className="flex items-start gap-3">
            <Button disabled variant="outline">
              <DownloadIcon aria-hidden />
              Download rejected rows
            </Button>
            <NotAvailable reason={`${NO_DROP_ZONE} Each download will be written to the access log on Privacy.`} />
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">Only admins can approve, discard or download this file.</p>
      )}
    </div>
  );
}
