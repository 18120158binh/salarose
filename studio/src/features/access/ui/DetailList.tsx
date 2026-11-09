import type { ReactNode } from "react";

export interface Detail {
  label: string;
  value: ReactNode;
  // Secondary text under the value, such as where the value comes from.
  note?: string;
}

// A titled card of label and value rows, for read-only facts about the viewer or the workspace.
export function DetailList({ title, details }: { title: string; details: readonly Detail[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="font-heading font-semibold text-base tracking-tight">{title}</h2>
      <dl className="divide-y divide-border rounded-lg border border-border bg-card">
        {details.map(({ label, value, note }) => (
          <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-6" key={label}>
            <dt className="shrink-0 text-muted-foreground text-sm sm:w-48">{label}</dt>
            <dd className="flex min-w-0 flex-col gap-0.5 text-sm">
              <div className="min-w-0 break-words">{value}</div>
              {note && <span className="text-muted-foreground text-xs">{note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
