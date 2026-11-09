"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { FileUpIcon, InfoIcon, LockIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callServerAction } from "@/shared/lib/serverAction";
import { formatDateTime } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { notify } from "@/shared/ui/v2/toast";
import {
  COLUMN_TYPES,
  DATASET_KINDS,
  LIST_ROLES,
  ROLE_LABELS,
  ROLE_RULES,
  SINGLE_ROLES,
  type ColumnType,
  type DatasetKind,
  type DatasetRoles,
  type DatasetVersion,
  type Delimiter,
  type DeliveryMode,
  type ListRole,
  type SingleRole,
} from "../../model/domain";
import {
  COLUMN_TYPE_LABELS,
  datasetHref,
  describeVersion,
  KIND_LABELS,
  NEW_DELIVERIES_ONLY,
  roleOf,
  saveLabel,
  usesOf,
  type DatasetDetail,
  type Refusal,
} from "../../model/datasets";
import { createDatasetAction, saveDatasetVersionAction } from "../../model/datasetsActions";
import { suggestColumns } from "../../model/datasetsSample";
import { parseDatasetVersion, SYSTEM_NAME_RULE, versionChange } from "../../model/version";

const REPORTING_TIME_ZONE = "Asia/Ho_Chi_Minh";

const ROLE_HELP: Record<SingleRole, string> = {
  customer_key: "Must equal the user id your website sends, character for character.",
  record_id: "A resent record replaces the stored one.",
  event_time: "When the record happened. Metric windows count from it.",
  updated_at: "Keeps the newest version when files arrive out of order.",
  deleted_flag: "True removes the row. Needs a True or false column.",
};

interface DraftColumn {
  name: string;
  displayName: string;
  type: ColumnType;
  pii: boolean;
  aliasText: string;
  isNew: boolean;
}

interface Draft {
  name: string;
  kind: DatasetKind;
  displayName: string;
  deliveryMode: DeliveryMode;
  timeZone: string;
  delimiter: Delimiter;
  columns: DraftColumn[];
  roles: DatasetRoles;
}

export type DatasetEditorProps =
  | { mode: "create"; zone: TimeZone }
  | { mode: "edit"; dataset: DatasetDetail; readOnly: boolean; zone: TimeZone };

function draftOf(props: DatasetEditorProps): Draft {
  if (props.mode === "create") {
    return {
      name: "",
      kind: "event",
      displayName: "",
      deliveryMode: "incremental",
      timeZone: REPORTING_TIME_ZONE,
      delimiter: ",",
      columns: [],
      roles: {},
    };
  }
  const { dataset } = props;
  const current = dataset.versions[0].value;
  return {
    name: dataset.name,
    kind: dataset.kind,
    displayName: dataset.displayName,
    deliveryMode: current.deliveryMode,
    timeZone: current.timeZone,
    delimiter: current.delimiter,
    columns: current.columns.map((column) => ({ ...column, aliasText: column.aliases.join(", "), isNew: false })),
    roles: current.roles,
  };
}

function versionInput(draft: Draft) {
  return {
    columns: draft.columns.map((column) => ({
      name: column.name,
      displayName: column.displayName,
      type: column.type,
      pii: column.pii,
      aliases: column.aliasText
        .split(",")
        .map((alias) => alias.trim())
        .filter((alias) => alias !== ""),
    })),
    roles: draft.roles,
    deliveryMode: draft.deliveryMode,
    timeZone: draft.timeZone,
    delimiter: draft.delimiter,
  };
}

const SELECT = "h-8 w-full rounded-control border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64";

function UploadDialog({ displayName }: { displayName: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>
        <UploadIcon aria-hidden />
        Upload file
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Upload a file to {displayName}</DialogTitle>
          <DialogDescription>Studio checks the file first and shows you what it would store. Nothing is stored until you apply.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Alert variant="info">
            <InfoIcon aria-hidden />
            <AlertTitle>Uploads are not available yet</AlertTitle>
            <AlertDescription>
              Checking and storing a file needs the import service, which is not running yet. You can still define the dataset and suggest
              columns from a sample CSV.
            </AlertDescription>
          </Alert>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function VersionsCard({ dataset, zone }: { dataset: DatasetDetail; zone: TimeZone }) {
  const { versions } = dataset;
  return (
    <SectionCard description="A saved version never changes. Each file records the version it was checked against." title="Versions">
      <ol className="flex flex-col gap-3">
        {versions.map((entry, index) => (
          <li className="flex flex-col gap-0.5 text-sm" key={entry.version}>
            <span className="flex items-center gap-2 font-medium">
              Version <span className="font-heading tabular-nums">{entry.version}</span>
              {index === 0 && <span className="rounded-full bg-primary/10 px-1.5 font-semibold text-primary text-xs">Current</span>}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(entry.createdAt, zone)}
              {entry.createdBy && ` · ${entry.createdBy}`}
            </span>
            <ul className="text-muted-foreground text-xs">
              {describeVersion(versions[index + 1]?.value ?? null, entry.value).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function WritersCard({ dataset, admin }: { dataset: DatasetDetail; admin: boolean }) {
  return (
    <SectionCard title={`Who sends ${dataset.displayName}`}>
      <ul className="flex flex-col gap-2 text-sm">
        {dataset.writers.map((writer) => (
          <li className="flex flex-col" key={writer.id}>
            <b className="font-medium">{writer.appId}</b>
            <span className="text-muted-foreground text-xs">Source key, may write {dataset.displayName}.</span>
          </li>
        ))}
        <li className="flex flex-col">
          <b className="font-medium">Studio uploads</b>
          <span className="text-muted-foreground text-xs">Admins, from this page. Shown as written by Studio.</span>
        </li>
      </ul>
      {admin && (
        <Link className="mt-2 text-primary text-sm underline-offset-2 hover:underline" href="/v2/data/sources">
          Manage on Sources
        </Link>
      )}
    </SectionCard>
  );
}

/** DIM-FR-01 to DIM-FR-07: the dataset editor board. An editor gets the same page, read-only. */
export function DatasetEditor(props: DatasetEditorProps) {
  const router = useRouter();
  const [baseline, setBaseline] = useState(() => draftOf(props));
  const [draft, setDraft] = useState(baseline);
  const [error, setError] = useState("");
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [sample, setSample] = useState<{ file: string; rows: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const editing = props.mode === "edit";
  const readOnly = props.mode === "edit" && props.readOnly;
  const current: DatasetVersion | null = props.mode === "edit" ? props.dataset.versions[0].value : null;
  const input = versionInput(draft);
  const parsed = parseDatasetVersion(draft.kind, input);
  const change = current !== null && parsed.ok ? versionChange(current, parsed.value) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const version = props.mode === "edit" ? props.dataset.version : 0;
  const label = editing ? saveLabel(change, dirty, version) : "Create dataset";
  const rules = ROLE_RULES[draft.kind];

  const update = (next: Partial<Draft>) => {
    setDraft((before) => ({ ...before, ...next }));
    setRefusals([]);
    setError("");
  };
  const updateColumn = (index: number, next: Partial<DraftColumn>) =>
    update({ columns: draft.columns.map((column, at) => (at === index ? { ...column, ...next } : column)) });
  const setRole = (role: SingleRole, column: string) => {
    const roles: DatasetRoles = { ...draft.roles };
    if (column === "") delete roles[role];
    else roles[role] = column;
    update({ roles });
  };
  const toggleListRole = (role: ListRole, column: string, on: boolean) => {
    const listed = new Set(draft.roles[role] ?? []);
    if (on) listed.add(column);
    else listed.delete(column);
    update({ roles: { ...draft.roles, [role]: [...listed] } });
  };
  const removeColumn = (index: number) => {
    const name = draft.columns[index].name;
    const roles: DatasetRoles = {};
    for (const role of SINGLE_ROLES) if (draft.roles[role] !== undefined && draft.roles[role] !== name) roles[role] = draft.roles[role];
    for (const role of LIST_ROLES) if (draft.roles[role]) roles[role] = draft.roles[role]?.filter((column) => column !== name);
    update({ columns: draft.columns.filter((_, at) => at !== index), roles });
  };
  const addColumn = () =>
    update({ columns: [...draft.columns, { name: "", displayName: "", type: "string", pii: false, aliasText: "", isNew: true }] });

  const readSample = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const suggestion = suggestColumns(await file.text(), draft.delimiter);
    if ("error" in suggestion) {
      setError(suggestion.error);
      return;
    }
    const known = new Set(draft.columns.map((column) => column.name));
    const added = suggestion.columns
      .filter((column) => !known.has(column.name))
      .map((column) => ({ ...column, aliasText: column.aliases.join(", "), isNew: true }));
    update({ columns: [...draft.columns, ...added] });
    setSample({ file: file.name, rows: suggestion.rows });
  };

  const save = () => {
    startTransition(async () => {
      const result = await callServerAction(() =>
        props.mode === "edit"
          ? saveDatasetVersionAction({ id: props.dataset.id, baseVersion: props.dataset.version, displayName: draft.displayName, version: input })
          : createDatasetAction({ name: draft.name, displayName: draft.displayName, kind: draft.kind, version: input }),
      );
      if ("error" in result) {
        setError(result.error);
        setRefusals("refusals" in result ? (result.refusals ?? []) : []);
        return;
      }
      notify({ kind: "done", title: result.version === version ? "Changes saved." : `Saved as version ${result.version}.` });
      if (props.mode === "create") router.push(datasetHref(result.id));
      else {
        setBaseline(draft);
        router.refresh();
      }
    });
  };

  const usesFor = (name: string) => (props.mode === "edit" ? props.dataset.uses[name] : undefined);
  const title = editing ? draft.displayName || props.dataset.displayName : "New dataset";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading font-semibold text-[1.1875rem] leading-tight">{title}</h1>
            {editing && (
              <>
                <span className="font-mono text-muted-foreground text-xs">{draft.name}</span>
                <span className="rounded-full bg-muted px-1.5 font-semibold text-[0.65625rem] text-muted-foreground">{KIND_LABELS[draft.kind]}</span>
                <span className="text-muted-foreground text-xs">
                  Version <span className="font-heading tabular-nums">{version}</span> · current
                </span>
              </>
            )}
            <PreviewBadge />
          </div>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2.5">
            {editing && <UploadDialog displayName={draft.displayName} />}
            <Button disabled={label === null || !parsed.ok || pending || refusals.length > 0} onClick={save}>
              {label ?? "No changes to save"}
            </Button>
          </div>
        )}
      </header>

      {readOnly && (
        <div className="flex items-center gap-2 rounded-control border border-border bg-card px-3 py-2 text-muted-foreground text-sm">
          <LockIcon aria-hidden className="size-4" />
          You can read this dataset. Only admins can change it or upload files.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {change?.rederives && (
            <Alert role="status" variant="info">
              <InfoIcon aria-hidden />
              <AlertTitle>Saving applies to new files only</AlertTitle>
              <AlertDescription>{NEW_DELIVERIES_ONLY}</AlertDescription>
            </Alert>
          )}
          {error !== "" && (
            <Alert variant="error">
              <AlertTitle>{refusals.length > 0 ? "Nothing was saved." : "Can't save yet."}</AlertTitle>
              <AlertDescription>
                <p className="whitespace-pre-line">{error}</p>
                {refusals.map((refusal) => (
                  <div key={refusal.column}>
                    <span className="font-mono">{refusal.column}</span> is used by:
                    <ul className="list-disc pl-5">
                      {refusal.uses.map((use) => (
                        <li key={use}>{use}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </AlertDescription>
            </Alert>
          )}

          <SectionCard title="Settings">
            <fieldset className="grid gap-4 sm:grid-cols-2" disabled={readOnly}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dataset-display-name">Display name</Label>
                <Input id="dataset-display-name" onChange={(event) => update({ displayName: event.target.value })} value={draft.displayName} />
                <p className="text-muted-foreground text-xs">What marketers see, like Orders &gt; Spend, last 90 days.</p>
              </div>
              {editing ? (
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium text-sm">System name and kind</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm">{draft.name}</span>
                    <span className="text-muted-foreground text-xs">{KIND_LABELS[draft.kind]}</span>
                  </span>
                  <p className="text-muted-foreground text-xs">Fixed after the dataset is created.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dataset-name">System name</Label>
                    <Input className="font-mono" id="dataset-name" onChange={(event) => update({ name: event.target.value })} placeholder="orders" spellCheck={false} value={draft.name} />
                    <p className="text-muted-foreground text-xs">{SYSTEM_NAME_RULE} Fixed after the dataset is created.</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dataset-kind">Each row is</Label>
                    <select className={SELECT} id="dataset-kind" onChange={(event) => update({ kind: event.target.value as DatasetKind, roles: {} })} value={draft.kind}>
                      {DATASET_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 font-medium text-sm">What each file holds</legend>
                {(
                  [
                    ["incremental", "New and changed rows", "Rows not in the file stay as they are."],
                    ["snapshot", "Every current row", "Rows the sender leaves out are removed. One sender only."],
                  ] as const
                ).map(([mode, name, help]) => (
                  <label className="flex items-start gap-2 text-sm" key={mode}>
                    <input checked={draft.deliveryMode === mode} className="mt-1 accent-primary" name="delivery-mode" onChange={() => update({ deliveryMode: mode })} type="radio" />
                    <span className="flex flex-col">
                      <b className="font-medium">{name}</b>
                      <span className="text-muted-foreground text-xs">{help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="dataset-time-zone">Time zone for dates without one</Label>
                  <select className={SELECT} id="dataset-time-zone" onChange={(event) => update({ timeZone: event.target.value })} value={draft.timeZone}>
                    {[...new Set([REPORTING_TIME_ZONE, "UTC", draft.timeZone])].map((zone) => (
                      <option key={zone} value={zone}>
                        {zone === REPORTING_TIME_ZONE ? `${zone} (reporting time zone)` : zone}
                      </option>
                    ))}
                  </select>
                </div>
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 font-medium text-sm">CSV separator</legend>
                  <div className="flex gap-4">
                    {(
                      [
                        [",", "Comma"],
                        [";", "Semicolon"],
                      ] as const
                    ).map(([delimiter, name]) => (
                      <label className="flex items-center gap-2 text-sm" key={delimiter}>
                        <input checked={draft.delimiter === delimiter} className="accent-primary" name="delimiter" onChange={() => update({ delimiter })} type="radio" />
                        {name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </fieldset>
          </SectionCard>

          <SectionCard
            actions={
              !readOnly && (
                <>
                  <input accept=".csv,text/csv" aria-label="Sample CSV file" className="hidden" onChange={readSample} ref={fileInput} type="file" />
                  <Button onClick={() => fileInput.current?.click()} size="sm" variant="outline">
                    <FileUpIcon aria-hidden />
                    Suggest from a sample file
                  </Button>
                  <Button onClick={addColumn} size="sm" variant="outline">
                    <PlusIcon aria-hidden />
                    Add column
                  </Button>
                </>
              )
            }
            description={
              sample ? (
                <>
                  Suggested from <span className="font-mono">{sample.file}</span>, <span className="font-heading tabular-nums">{sample.rows}</span> rows. Check
                  each type before you save.
                </>
              ) : undefined
            }
            flush
            title="Columns"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border border-b text-left text-muted-foreground text-xs">
                    <th className="px-3 py-2 font-semibold">Column</th>
                    <th className="px-3 py-2 font-semibold">Type</th>
                    <th className="px-3 py-2 font-semibold">Role</th>
                    <th className="px-3 py-2 font-semibold">Personal data</th>
                    <th className="px-3 py-2 font-semibold">Also accepts header</th>
                    {editing && <th className="px-3 py-2 font-semibold">Used by</th>}
                    {!readOnly && (
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {draft.columns.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-center text-muted-foreground" colSpan={7}>
                        No columns yet. Suggest them from a sample file or add one.
                      </td>
                    </tr>
                  )}
                  {draft.columns.map((column, index) => {
                    const role = roleOf(draft.roles, column.name);
                    const contact = role === "email" || role === "phone";
                    const uses = usesFor(column.name);
                    const usedBy = uses ? usesOf(uses) : [];
                    const refused = refusals.some((refusal) => refusal.column === column.name);
                    const name = column.displayName || column.name || `column ${index + 1}`;
                    return (
                      <tr className={refused ? "border-border border-b bg-destructive/5" : "border-border border-b"} key={index}>
                        <td className="px-3 py-2 align-top">
                          {readOnly ? (
                            <span className="font-medium">{column.displayName}</span>
                          ) : (
                            <Input aria-label={`Display name of ${name}`} onChange={(event) => updateColumn(index, { displayName: event.target.value })} size="sm" value={column.displayName} />
                          )}
                          {column.isNew && !readOnly ? (
                            <Input
                              aria-label={`System name of ${name}`}
                              className="mt-1 font-mono"
                              onChange={(event) => updateColumn(index, { name: event.target.value })}
                              placeholder="system_name"
                              size="sm"
                              spellCheck={false}
                              value={column.name}
                            />
                          ) : (
                            <span className="block font-mono text-muted-foreground text-xs">{column.name}</span>
                          )}
                          {column.isNew && editing && <span className="text-primary text-xs">New in v{version + 1}</span>}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select aria-label={`Type of ${name}`} className={SELECT} disabled={readOnly} onChange={(event) => updateColumn(index, { type: event.target.value as ColumnType })} value={column.type}>
                            {COLUMN_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {COLUMN_TYPE_LABELS[type]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top text-xs">{role ? <span className="font-semibold">{ROLE_LABELS[role]}</span> : <span className="text-muted-foreground">Field</span>}</td>
                        <td className="px-3 py-2 align-top">
                          <label className="flex items-center gap-2 text-xs">
                            <input checked={column.pii || contact} className="accent-primary" disabled={readOnly || contact} onChange={(event) => updateColumn(index, { pii: event.target.checked })} type="checkbox" />
                            {column.pii || contact ? "Yes, masked" : "No"}
                          </label>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {readOnly ? (
                            <span className="font-mono text-xs">{column.aliasText}</span>
                          ) : (
                            <Input aria-label={`Other headers for ${name}`} className="font-mono" onChange={(event) => updateColumn(index, { aliasText: event.target.value })} placeholder="ma_don, tong_tien" size="sm" value={column.aliasText} />
                          )}
                        </td>
                        {editing && <td className="px-3 py-2 align-top text-xs">{usedBy.length > 0 ? usedBy.join(" · ") : <span className="text-muted-foreground">Not used yet</span>}</td>}
                        {!readOnly && (
                          <td className="px-3 py-2 align-top">
                            <Button aria-label={`Delete column ${name}`} onClick={() => removeColumn(index)} size="icon-sm" variant="ghost">
                              <Trash2Icon aria-hidden />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-muted-foreground text-xs">
              Types: Text, Number, True or false, Date and time, JSON. Personal data is masked everywhere in Studio, for admins too.
            </p>
          </SectionCard>

          <SectionCard description="Studio needs these to store a row and link it to a customer. Starred roles are required." title="Which column is which">
            <fieldset className="grid gap-4 sm:grid-cols-2" disabled={readOnly}>
              {SINGLE_ROLES.filter((role) => rules[role] !== "absent").map((role) => (
                <div className="flex flex-col gap-1.5" key={role}>
                  <Label htmlFor={`role-${role}`}>
                    {ROLE_LABELS[role]}
                    {rules[role] === "required" && " *"}
                  </Label>
                  <select className={SELECT} id={`role-${role}`} onChange={(event) => setRole(role, event.target.value)} value={draft.roles[role] ?? ""}>
                    <option value="">{rules[role] === "required" ? "Pick a column" : "None"}</option>
                    {draft.columns
                      .filter((column) => column.name !== "")
                      .map((column) => (
                        <option key={column.name} value={column.name}>
                          {column.displayName || column.name} · {column.name}
                        </option>
                      ))}
                  </select>
                  <p className="text-muted-foreground text-xs">{ROLE_HELP[role]}</p>
                </div>
              ))}
              {LIST_ROLES.every((role) => rules[role] === "absent") ? (
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium text-sm">Email and phone</span>
                  <p className="text-muted-foreground text-xs">Only for datasets with one row per customer, like Customers.</p>
                </div>
              ) : (
                LIST_ROLES.map((role) => (
                  <fieldset className="flex flex-col gap-1.5" key={role}>
                    <legend className="mb-1.5 font-medium text-sm">{ROLE_LABELS[role]}</legend>
                    {draft.columns
                      .filter((column) => column.name !== "")
                      .map((column) => (
                        <label className="flex items-center gap-2 text-sm" key={column.name}>
                          <input
                            checked={draft.roles[role]?.includes(column.name) ?? false}
                            className="accent-primary"
                            onChange={(event) => toggleListRole(role, column.name, event.target.checked)}
                            type="checkbox"
                          />
                          {column.displayName || column.name}
                        </label>
                      ))}
                    <p className="text-muted-foreground text-xs">Always personal data, so masked.</p>
                  </fieldset>
                ))
              )}
            </fieldset>
          </SectionCard>

          {!readOnly && !parsed.ok && draft.columns.length > 0 && (
            <div className="text-muted-foreground text-xs" role="status">
              <p className="font-medium">Before you can save:</p>
              <ul className="list-disc pl-5">
                {parsed.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {props.mode === "edit" && (
          <aside className="flex flex-col gap-4">
            <VersionsCard dataset={props.dataset} zone={props.zone} />
            <WritersCard admin={!props.readOnly} dataset={props.dataset} />
            <SectionCard title="Where marketers see it">
              <p className="text-muted-foreground text-sm">
                Through metrics on {props.dataset.displayName}, in segment and journey conditions.
              </p>
              <Link className="mt-2 text-primary text-sm underline-offset-2 hover:underline" href="/v2/data/metrics">
                Metrics on {props.dataset.displayName}
              </Link>
            </SectionCard>
          </aside>
        )}
      </div>
    </div>
  );
}
