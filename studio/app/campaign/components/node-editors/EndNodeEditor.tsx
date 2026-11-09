import React from "react";

// An End node has nothing to configure. See the node types in docs/internal/features/journey-builder.md.
export default function EndNodeEditor() {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4">
      <p className="text-sm font-semibold text-foreground">The journey ends here</p>
      <p className="text-xs text-muted-foreground">
        Users who reach this point leave the journey. An End node has no settings. Add a node from the palette to continue
        this path instead.
      </p>
    </div>
  );
}
