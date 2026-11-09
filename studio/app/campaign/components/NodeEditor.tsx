import React, { useEffect, useState } from "react";
import { CampaignNode } from "@/entities/journey/model/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import type { UserEventDef } from "@/types";

// Import node-specific editors
import TriggerNodeEditor from "./node-editors/TriggerNodeEditor";
import CheckNodeEditor from "./node-editors/CheckNodeEditor";
import WatchNodeEditor from "./node-editors/WatchNodeEditor";
import SegmentNodeEditor from "./node-editors/SegmentNodeEditor";
import ActionNodeEditor from "./node-editors/ActionNodeEditor";
import EndNodeEditor from "./node-editors/EndNodeEditor";
import type { NodeConfig, NodeUpdateHandler } from "./node-editors/editorTypes";

/** The catalog events the pickers offer, loaded once for the builder. */
export interface BuilderPickers {
  userEvents: UserEventDef[];
}

// The editor keeps unapplied edits in its own state, so the builder mounts one per node id.
interface NodeEditorProps {
  node: CampaignNode;
  onUpdate: NodeUpdateHandler;
  onClose: () => void;
  onDeleteNode: (id: string) => void;
  readOnly?: boolean;
  pickers: BuilderPickers;
}

const USER_PROFILE_FIELDS: FieldDef[] = [
  { value: "gender", label: "Gender", group: "user", type: "string" },
  { value: "age", label: "Age", group: "user", type: "number" },
  { value: "city", label: "City", group: "user", type: "string" },
  { value: "user_time", label: "User Time", group: "user", type: "string" }
];

export default function NodeEditor({
  node,
  onUpdate,
  onClose,
  onDeleteNode,
  readOnly = false,
  pickers,
}: NodeEditorProps) {
  const [config, setConfig] = useState<NodeConfig>(() => ({ ...(node.config || {}) }));
  const [label, setLabel] = useState(node.label || "");
  const { userEvents } = pickers;

  const [width, setWidth] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("campaign-node-editor-width");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 320 && parsed <= 900) {
          return parsed;
        }
      }
    }
    return 400; // default slightly wider for tabs
  });

  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    return () => {
      document.body.style.userSelect = "";
    };
  }, []);

  const startResize = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
    const startWidth = width;
    const startX = mouseDownEvent.clientX;
    const doResize = (mouseMoveEvent: MouseEvent) => {
      const deltaX = mouseMoveEvent.clientX - startX;
      const newWidth = Math.max(320, Math.min(900, startWidth - deltaX));
      setWidth(newWidth);
      localStorage.setItem("campaign-node-editor-width", String(newWidth));
    };
    const stopResize = () => {
      setIsResizing(false);
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", doResize);
      window.removeEventListener("mouseup", stopResize);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", doResize);
    window.addEventListener("mouseup", stopResize);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdate(config, label);
  };

  const handleFieldChange = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const businessEvents = [
    { id: 'be_price_drop', name: 'price_drop', label: 'Price Drop', catalog: 'products', stateField: 'price', fields: [
      { value: 'product_id', label: 'Product ID', dataType: 'string' },
      { value: 'product_name', label: 'Product Name', dataType: 'string' },
      { value: 'price', label: 'Price', dataType: 'number' },
      { value: 'category', label: 'Category', dataType: 'string' },
      { value: 'brand', label: 'Brand', dataType: 'string' },
      { value: 'color', label: 'Color', dataType: 'string' },
      { value: 'storage', label: 'Storage Capacity', dataType: 'string' },
      { value: 'image_url', label: 'Image URL', dataType: 'string' },
    ]},
    { id: 'be_back_in_stock', name: 'back_in_stock', label: 'Back in Stock', catalog: 'products', stateField: 'stock_status', fields: [
      { value: 'product_id', label: 'Product ID', dataType: 'string' },
      { value: 'product_name', label: 'Product Name', dataType: 'string' },
      { value: 'stock_status', label: 'Stock Status', dataType: 'string' },
      { value: 'quantity', label: 'Quantity', dataType: 'number' },
      { value: 'category', label: 'Category', dataType: 'string' },
      { value: 'brand', label: 'Brand', dataType: 'string' },
      { value: 'color', label: 'Color', dataType: 'string' },
      { value: 'storage', label: 'Storage Capacity', dataType: 'string' },
      { value: 'image_url', label: 'Image URL', dataType: 'string' },
    ]},
  ];

  const allEventsList = [...userEvents, ...businessEvents];

  const isEnd = node.type === "end";

  const renderFields = () => {
    if (isEnd) return <EndNodeEditor />;
    switch (node.subType) {
      case "setup":
        return <TriggerNodeEditor config={config} handleFieldChange={handleFieldChange} readOnly={readOnly} userEvents={userEvents} businessEvents={businessEvents} userProfileFields={USER_PROFILE_FIELDS} />;
      case "check":
        return <CheckNodeEditor config={config} handleFieldChange={handleFieldChange} onUpdate={onUpdate} label={label} readOnly={readOnly} allEventsList={allEventsList} userProfileFields={USER_PROFILE_FIELDS} />;
      case "watch":
        return <WatchNodeEditor config={config} handleFieldChange={handleFieldChange} onUpdate={onUpdate} label={label} readOnly={readOnly} allEventsList={allEventsList} userProfileFields={USER_PROFILE_FIELDS} />;
      case "segment":
        return <SegmentNodeEditor config={config} handleFieldChange={handleFieldChange} onUpdate={onUpdate} label={label} readOnly={readOnly} events={userEvents} userProfileFields={USER_PROFILE_FIELDS} />;
      default:
        return <ActionNodeEditor config={config} handleFieldChange={handleFieldChange} subType={node.subType} readOnly={readOnly} />;
    }
  };

  return (
    <div className="relative border-l border-border bg-background shrink-0 flex flex-col h-full border-t" style={{ width: `${width}px` }}>
      {/* Drag Resize Handle */}
      <div
        onMouseDown={startResize}
        className={`absolute top-0 bottom-0 left-0 w-1.5 -translate-x-0.5 cursor-col-resize hover:bg-primary/40 active:bg-primary z-50 transition-colors ${
          isResizing ? "bg-primary" : ""
        }`}
        title="Drag left/right to resize panel"
      />
      <div className="p-4 border-b border-border flex items-center justify-between bg-muted/10">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
            {node.type} predicate
          </span>
          <h3 className="text-sm font-bold text-foreground mt-0.5">{node.label}</h3>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <form onSubmit={handleSave} className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden border-0 p-0 m-0">
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* Node label editing. An End node saves no label. */}
            {!isEnd && <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Node Display Name
              </label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Enter node name"
                className="font-semibold"
                disabled={readOnly}
              />
            </div>}

            {/* Render Tabbed Editors */}
            {renderFields()}
          </div>

          {!readOnly ? (
            <div className="p-4 border-t border-border space-y-2 bg-muted/10 shrink-0">
              {!isEnd && (
                <Button type="submit" variant="default" className="w-full">
                  Apply Predicate
                </Button>
              )}
              {node.type !== "setup" && (
                <Button
                  type="button"
                  variant="destructive-outline"
                  className="w-full"
                  onClick={() => onDeleteNode(node.id)}
                >
                  Delete Node
                </Button>
              )}
            </div>
          ) : (
            <div className="p-5 border-t border-border bg-muted/20 shrink-0 text-center text-xs text-muted-foreground font-semibold flex items-center justify-center gap-1.5">
              <span>🔒</span> Read-Only Mode
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
