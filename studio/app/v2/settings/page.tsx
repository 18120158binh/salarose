import { UsersIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { previewStaff } from "@/features/access/model/server";
import { ROLE_LABELS, workspaceSettings, type WorkspaceSettings } from "@/features/access/model/settings";
import { DetailList } from "@/features/access/ui/DetailList";
import { getAuthConfig } from "@/shared/auth/config";
import { formatDuration, NOT_AVAILABLE } from "@/shared/lib/format";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { Forbidden, RegionEmpty, TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

const SET_BY_DEPLOYMENT = "Set by the deployment";

// Data import has no reader yet, so its settings have no variable and show their documented
// defaults (configuration.md, Data import).
const DATA_IMPORT = [
  {
    label: "Default phone country",
    value: "Vietnam (+84)",
    note: `Phone numbers without a country code are read as Vietnamese. ${SET_BY_DEPLOYMENT}`,
  },
  {
    label: "Reporting time zone",
    value: "Asia/Ho_Chi_Minh",
    note: `The nightly pass runs at 03:00 in this zone. ${SET_BY_DEPLOYMENT}`,
  },
];

// SHL-FR-20: the workspace configuration, read-only, and the staff with preview access, for admins.
// An editor gets the forbidden state before the page reads anything.
export default async function V2SettingsPage() {
  if (!(await openRoute("settings"))) return <Forbidden />;

  const settings = workspaceSettings(process.env, getAuthConfig);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader description="How this workspace is set up. The deployment's configuration sets these values." preview title="Settings" />
      <DetailList details={workspaceDetails(settings)} title="Workspace" />
      <DetailList details={DATA_IMPORT} title="Data import" />
      <section aria-label="Preview access" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading font-semibold text-base tracking-tight">Preview access</h2>
          <p className="text-muted-foreground text-sm">
            Staff who see new pages before they reach everyone. Admins always have preview access. Grant or revoke it in the
            database, as the operations guide says.
          </p>
        </div>
        <DataRegion errorMessage="Preview access could not load." loading={<TableSkeleton rows={3} />}>
          <PreviewStaffTable />
        </DataRegion>
        <p className="text-muted-foreground text-xs">Read only. Studio has no screen to grant access.</p>
      </section>
    </div>
  );
}

function workspaceDetails(settings: WorkspaceSettings) {
  const limits = settings.rateLimits;
  return [
    { label: "Workspace name", value: settings.workspace },
    { label: "Sign-in providers", value: settings.providers?.join(", ") || NOT_AVAILABLE },
    {
      label: "Session length",
      value: settings.sessionSeconds === null ? NOT_AVAILABLE : formatDuration(settings.sessionSeconds * 1000),
    },
    { label: "AI generation", value: settings.aiGenerationConfigured ? "Configured" : "Not configured" },
    {
      label: "AI generation limits",
      value: limits
        ? `${limits.perMinute} per minute and ${limits.perDay} per day, for each user`
        : "Not available. A limit is invalid, so AI generation refuses requests.",
    },
  ].map((detail) => ({ ...detail, note: SET_BY_DEPLOYMENT }));
}

async function PreviewStaffTable() {
  const staff = await previewStaff();
  if (staff.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <RegionEmpty icon={UsersIcon} message="No staff member has the preview flag. Admins still see preview pages." />
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {staff.map((person, row) => (
            // One person who signed in at two providers has two rows with one email.
            <TableRow key={`${row}:${person.email}`}>
              <TableCell>{person.email}</TableCell>
              <TableCell>
                <Badge size="sm" variant="secondary">
                  {ROLE_LABELS[person.role]}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
