"use client";

import { useId, type Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lock } from "lucide-react";
import type { EventKind } from "shared/lib/eventCatalog";

const KIND_OPTIONS = [
  { value: "person", label: "Person", hint: "An event a person does, sent with a person id." },
  { value: "business", label: "Business", hint: "An event about an item, such as price_drop, sent with no person." },
] as const satisfies readonly { value: EventKind["kind"]; label: string; hint: string }[];

export const ITEM_KEY_REQUIRED = "Item key is required for a business event.";

interface EventKindRadioGroupProps {
  value: EventKind["kind"];
  onValueChange: (kind: EventKind["kind"]) => void;
  disabled?: boolean;
  businessDisabled?: boolean;
}

export function EventKindRadioGroup({ value, onValueChange, disabled, businessDisabled }: EventKindRadioGroupProps) {
  const id = useId();
  return (
    <Fieldset className="space-y-2">
      <FieldsetLegend className="text-sm font-medium">Kind</FieldsetLegend>
      <RadioGroup
        className="grid grid-cols-2 gap-2"
        disabled={disabled}
        onValueChange={(next) => onValueChange(next as EventKind["kind"])}
        value={value}
      >
        {KIND_OPTIONS.map((option) => (
          <Label
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-foreground has-data-disabled:cursor-not-allowed has-data-disabled:opacity-64"
            key={option.value}
          >
            <Radio
              aria-describedby={`${id}-${option.value}`}
              className="mt-0.5"
              disabled={option.value === "business" && businessDisabled}
              value={option.value}
            />
            <span>
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground" id={`${id}-${option.value}`}>
                {option.hint}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
    </Fieldset>
  );
}

const ITEM_KEY_HELP = "The attribute that names the item, such as product.id. It cannot be renamed or deleted later.";
const NO_ATTRIBUTES = "Add an attribute first";

interface ItemKeySelectProps {
  paths: readonly string[];
  value: string | null;
  onValueChange: (path: string | null) => void;
  error?: string;
  triggerRef?: Ref<HTMLButtonElement>;
}

export function ItemKeySelect({ paths, value, onValueChange, error, triggerRef }: ItemKeySelectProps) {
  const id = useId();
  const hasPaths = paths.length > 0;
  return (
    <Field className="col-span-2" invalid={Boolean(error)}>
      <FieldLabel>Item key</FieldLabel>
      <Select disabled={!hasPaths} onValueChange={(path) => onValueChange(path)} value={value}>
        <SelectTrigger aria-describedby={error ? `${id}-error` : `${id}-help`} aria-invalid={Boolean(error)} ref={triggerRef}>
          <SelectValue className="font-mono" placeholder={hasPaths ? "Choose an attribute" : NO_ATTRIBUTES} />
        </SelectTrigger>
        <SelectContent>
          {paths.map((path) => (
            <SelectItem className="font-mono" key={path} value={path}>
              {path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription id={`${id}-help`}>
        {hasPaths ? ITEM_KEY_HELP : `${NO_ATTRIBUTES}. ${ITEM_KEY_HELP}`}
      </FieldDescription>
      {error && (
        <FieldError id={`${id}-error`} match>
          {error}
        </FieldError>
      )}
    </Field>
  );
}

// A business event's item key, shown but not editable.
export function FixedItemKey({ itemKey }: { itemKey: string }) {
  const id = useId();
  return (
    <Field className="col-span-2" disabled>
      <FieldLabel>Item key</FieldLabel>
      <Select disabled value={itemKey}>
        <SelectTrigger aria-describedby={`${id}-fixed`}>
          <SelectValue className="font-mono" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem className="font-mono" value={itemKey}>
            {itemKey}
          </SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription className="flex items-center gap-1" id={`${id}-fixed`}>
        <Lock aria-hidden="true" className="size-3" />
        Fixed once the event is business.
      </FieldDescription>
    </Field>
  );
}

export function EventKindBadge({ eventKind }: { eventKind: EventKind }) {
  switch (eventKind.kind) {
    case "person":
      return <Badge variant="outline">Person</Badge>;
    case "business":
      return <Badge variant="info">Business</Badge>;
    default: {
      const unknownKind: never = eventKind;
      throw new Error(`Unknown event kind ${JSON.stringify(unknownKind)}`);
    }
  }
}
