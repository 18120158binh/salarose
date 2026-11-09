"use client";

import { useRouter } from "next/navigation";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryHref, REASON_CHOICES, type DeadLetterQuery, type ReasonChoice, type RecordChoice } from "../model/deadLetterQuery";
import { REASON_LABELS } from "../model/deadLetterView";

const ALL = "all";

const REASON_OPTIONS: readonly { value: ReasonChoice | typeof ALL; label: string }[] = [
  { value: ALL, label: "Any reason" },
  ...REASON_CHOICES.map((reason) => ({ value: reason, label: REASON_LABELS[reason] })),
];

const RECORD_OPTIONS: readonly { value: RecordChoice | typeof ALL; label: string }[] = [
  { value: ALL, label: "Events and requests" },
  { value: "event", label: "Events only" },
  { value: "payload", label: "Requests only" },
];

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
      {label}
    <Select onValueChange={(next) => onChange(next as T)} value={value}>
      <SelectTrigger aria-label={label} className="w-52" size="sm">
        <SelectValue>{options.find((option) => option.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
    </label>
  );
}

// The filters live in the address, as the window does, so a filtered list can be shared. `base` is
// the page that holds the browser, with any parameter of its own, such as the Monitoring tab.
export function DeadLetterFilters({ query, base }: { query: DeadLetterQuery; base: string }) {
  const router = useRouter();
  const go = (next: DeadLetterQuery) => router.push(queryHref(base, next), { scroll: false });
  return (
    <>
      <FilterSelect
        label="Why"
        onChange={(reason) => go({ ...query, reason: reason === ALL ? null : reason })}
        options={REASON_OPTIONS}
        value={query.reason ?? ALL}
      />
      <FilterSelect
        label="Record"
        onChange={(record) => go({ ...query, record: record === ALL ? null : record })}
        options={RECORD_OPTIONS}
        value={query.record ?? ALL}
      />
    </>
  );
}
