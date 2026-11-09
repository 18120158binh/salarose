import Link from "next/link";
import { cn } from "@/lib/utils";
import { zoneLabel, type TimeZone } from "@/shared/lib/time-range";

export interface RangePickerProps<Key extends string> {
  // The ranges the page offers, in order, and how each one reads.
  options: readonly Key[];
  label: (key: Key) => string;
  value: Key;
  // The zone the server counted in. The picker names it (SHL-FR-15).
  zone: TimeZone;
  // What the range covers, after the zone, such as every tab of a section.
  scope?: string;
  // The address of the page with another range, so the range stays in the address.
  href: (key: Key) => string;
}

// DESIGN.md page-level control: a pill group of links, one per range, under the page header.
export function RangePicker<Key extends string>({ options, label, value, zone, scope, href }: RangePickerProps<Key>) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <nav aria-label="Time range" className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary p-1">
        {options.map((key) => (
          <Link
            aria-current={key === value ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-3 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              key === value
                ? "bg-background text-foreground shadow-xs dark:bg-input"
                : "text-muted-foreground hover:text-foreground",
            )}
            href={href(key)}
            key={key}
            scroll={false}
          >
            {label(key)}
          </Link>
        ))}
      </nav>
      <p className="text-muted-foreground text-xs">{zoneLabel(zone)}
        {scope && ` · ${scope}`}
      </p>
    </div>
  );
}
