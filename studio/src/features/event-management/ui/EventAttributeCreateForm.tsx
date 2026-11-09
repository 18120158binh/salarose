import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeEventAttributePath } from "@/features/event-management/model/eventAttributeTree";
import { EVENT_ATTRIBUTE_TYPES } from "shared/lib/eventCatalog";
import type { FormEvent } from "react";

interface EventAttributeCreateFormProps {
  dataType: string;
  displayName: string;
  eventId: string;
  exampleValue: string;
  fieldKey: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onDataTypeChange: (dataType: string) => void;
  onDisplayNameChange: (displayName: string) => void;
  onExampleValueChange: (exampleValue: string) => void;
  onFieldKeyChange: (fieldKey: string) => void;
  onSubmit: (event: FormEvent) => void;
  parentPath: string | null;
}

export function EventAttributeCreateForm({
  dataType,
  displayName,
  eventId,
  exampleValue,
  fieldKey,
  isSubmitting,
  onCancel,
  onDataTypeChange,
  onDisplayNameChange,
  onExampleValueChange,
  onFieldKeyChange,
  onSubmit,
  parentPath,
}: EventAttributeCreateFormProps) {
  return (
    <form
      className="border-t bg-primary/[0.03] p-3"
      onSubmit={onSubmit}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold">
            {parentPath ? "New child attribute" : "New attribute"}
          </span>
          {parentPath && (
            <Badge
              className="max-w-64 truncate font-mono font-normal"
              title={normalizeEventAttributePath(parentPath)}
              variant="secondary"
            >
              inside {normalizeEventAttributePath(parentPath)}
            </Badge>
          )}
        </div>
        <Button
          onClick={onCancel}
          size="xs"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>

      <div className="grid min-w-[760px] grid-cols-[minmax(280px,1.5fr)_120px_minmax(150px,.8fr)_auto] items-end gap-3">
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <Field className="min-w-0" name="attributeKey">
            <FieldLabel
              className="text-[11px]"
              htmlFor={`attribute-key-${eventId}`}
            >
              {parentPath ? "Child key" : "Attribute key"}
            </FieldLabel>
            <Input
              className="h-8 min-w-0 font-mono text-xs"
              id={`attribute-key-${eventId}`}
              name="attributeKey"
              onChange={(event) => onFieldKeyChange(event.target.value)}
              pattern="[^.]+"
              placeholder={parentPath ? "e.g., price" : "e.g., product_id"}
              required
              title="Enter one attribute key without dots."
              type="text"
              value={fieldKey}
            />
          </Field>
          <Field className="min-w-0" name="displayName">
            <FieldLabel
              className="text-[11px]"
              htmlFor={`attribute-label-${eventId}`}
            >
              Display name
            </FieldLabel>
            <Input
              className="h-8 min-w-0 text-xs"
              id={`attribute-label-${eventId}`}
              name="displayName"
              onChange={(event) =>
                onDisplayNameChange(event.target.value)
              }
              placeholder="e.g., Product ID"
              required
              type="text"
              value={displayName}
            />
          </Field>
        </div>

        <Field className="min-w-0" name="dataType">
          <FieldLabel className="text-[11px]">Data type</FieldLabel>
          <Select
            onValueChange={(value) => {
              if (value) onDataTypeChange(value);
            }}
            value={dataType}
          >
            <SelectTrigger
              aria-label="Data Type"
              className="h-8 min-w-0 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_ATTRIBUTE_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field className="min-w-0" name="exampleValue">
          <FieldLabel
            className="text-[11px]"
            htmlFor={`attribute-example-${eventId}`}
          >
            Example <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Input
            className="h-8 min-w-0 text-xs"
            disabled={dataType === "json"}
            id={`attribute-example-${eventId}`}
            name="exampleValue"
            onChange={(event) =>
              onExampleValueChange(event.target.value)
            }
            placeholder="e.g., SKU-123"
            type="text"
            value={exampleValue}
          />
        </Field>

        <Button
          className="min-w-28"
          loading={isSubmitting}
          size="sm"
          type="submit"
        >
          {isSubmitting ? "Saving..." : "Save attribute"}
        </Button>
      </div>
    </form>
  );
}
