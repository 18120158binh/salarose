import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildEventAttributeTree,
  type EventAttributeTreeNode,
} from "@/features/event-management/model/eventAttributeTree";
import type { EditableEventAttribute } from "@/features/event-management/model/eventAttributePayload";
import { EventAttributeTreeConnector } from "@/features/event-management/ui/EventAttributeTreeConnector";
import { EVENT_ATTRIBUTE_TYPES } from "shared/lib/eventCatalog";
import { Plus, Trash2 } from "lucide-react";

interface EventAttributeTreeEditorProps {
  attributes: EditableEventAttribute[];
  onAdd: (parentPath?: string) => void;
  onChange: (
    attributeId: string,
    changes: Partial<EditableEventAttribute>,
  ) => void;
  onDelete: (attributePath: string) => void;
  onRename: (attributePath: string, nextKey: string) => void;
}

function AttributeNode({
  depth,
  node,
  onAdd,
  onChange,
  onDelete,
  onRename,
}: {
  depth: number;
  node: EventAttributeTreeNode<EditableEventAttribute>;
} & Omit<EventAttributeTreeEditorProps, "attributes">) {
  const attribute = node.attribute;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div className="grid min-w-[760px] grid-cols-[minmax(210px,1.35fr)_minmax(170px,1fr)_140px_minmax(150px,1fr)_36px] items-center border-t">
        <div
          className="relative min-w-0 p-2"
          style={{ paddingInlineStart: `${depth * 24 + 8}px` }}
        >
          <EventAttributeTreeConnector depth={depth} />
          {attribute ? (
            <Input
              aria-label={`Attribute key for ${node.path}`}
              className="h-8 bg-transparent font-mono text-xs"
              defaultValue={node.key}
              key={`${attribute.id}-${node.path}`}
              onBlur={(event) => onRename(node.path, event.target.value)}
              pattern="[^.]+"
              required
              title="Enter one attribute key without dots."
              type="text"
            />
          ) : (
            <span className="relative px-3 font-mono text-xs font-medium">
              {node.key}
            </span>
          )}
        </div>

        <div className="min-w-0 p-2">
          {attribute ? (
            <Input
              aria-label={`Display name for ${node.path}`}
              className="h-8 bg-transparent text-xs"
              onChange={(event) =>
                onChange(attribute.id, { displayName: event.target.value })
              }
              type="text"
              value={attribute.displayName}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              Structural group
            </span>
          )}
        </div>

        <div className="min-w-0 p-2">
          {attribute ? (
            <Select
              disabled={hasChildren}
              onValueChange={(dataType) =>
                onChange(attribute.id, {
                  dataType: String(dataType),
                  ...(dataType === "json" ? { exampleValue: "" } : {}),
                })
              }
              value={attribute.dataType}
            >
              <SelectTrigger
                aria-label={`Data type for ${node.path}`}
                className="h-8 min-w-0 bg-transparent text-xs"
                title={
                  hasChildren
                    ? "Attributes with children are JSON objects."
                    : undefined
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_ATTRIBUTE_TYPES.map((dataType) => (
                  <SelectItem key={dataType.value} value={dataType.value}>
                    {dataType.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge className="font-normal" variant="outline">
              JSON group
            </Badge>
          )}
        </div>

        <div className="min-w-0 p-2">
          {attribute ? (
            <Input
              aria-label={`Example value for ${node.path}`}
              className="h-8 bg-transparent text-xs"
              disabled={attribute.dataType === "json" || hasChildren}
              onChange={(event) =>
                onChange(attribute.id, { exampleValue: event.target.value })
              }
              placeholder={
                attribute.dataType === "json" || hasChildren
                  ? "Defined by children"
                  : "—"
              }
              type="text"
              value={attribute.exampleValue}
            />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        <div className="p-2">
          {attribute && (
            <Button
              aria-label={`Delete ${node.path}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(node.path)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {node.children.map((child) => (
        <AttributeNode
          depth={depth + 1}
          key={child.path}
          node={child}
          onAdd={onAdd}
          onChange={onChange}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}

      <div className="grid min-w-[760px] grid-cols-[minmax(210px,1.35fr)_minmax(170px,1fr)_140px_minmax(150px,1fr)_36px]">
        <div
          className="relative flex min-h-9 items-center py-1"
          style={{ paddingInlineStart: `${(depth + 1) * 24 + 8}px` }}
        >
          <EventAttributeTreeConnector depth={depth + 1} />
          <Button
            aria-label={`Add attribute inside ${node.path}`}
            className="relative px-1.5 text-foreground"
            onClick={() => onAdd(node.path)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Plus aria-hidden="true" />
            Add attribute
          </Button>
        </div>
      </div>
    </>
  );
}

export function EventAttributeTreeEditor({
  attributes,
  onAdd,
  onChange,
  onDelete,
  onRename,
}: EventAttributeTreeEditorProps) {
  const tree = buildEventAttributeTree(attributes);

  return (
    <div className="overflow-x-auto rounded-lg border bg-background">
      <div className="grid min-w-[760px] grid-cols-[minmax(210px,1.35fr)_minmax(170px,1fr)_140px_minmax(150px,1fr)_36px] bg-muted/50 text-xs font-medium text-muted-foreground">
        <div className="p-2">Attribute Key</div>
        <div className="p-2">Display Name</div>
        <div className="p-2">Data Type</div>
        <div className="p-2">Example</div>
        <div />
      </div>

      {tree.children.map((node) => (
        <AttributeNode
          depth={0}
          key={node.path}
          node={node}
          onAdd={onAdd}
          onChange={onChange}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}

      <div className="grid min-w-[760px] grid-cols-[minmax(210px,1.35fr)_minmax(170px,1fr)_140px_minmax(150px,1fr)_36px] border-t">
        <div className="flex min-h-10 items-center p-2">
          <Button
            aria-label="Add Attribute"
            className="px-1.5 text-foreground"
            onClick={() => onAdd()}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Plus aria-hidden="true" />
            Add Attribute
          </Button>
        </div>
      </div>
    </div>
  );
}
