import type { ReactNode } from "react";
import { PreviewBadge } from "./PreviewBadge";

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  // At most one primary button, then secondary buttons or a menu.
  actions?: ReactNode;
  // Page-level controls, such as the time range, in a row under the header.
  controls?: ReactNode;
  // The page's route is at stage preview (SHL-FR-22).
  preview?: boolean;
}

export function PageHeader({ title, description, actions, controls, preview = false }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="font-heading font-semibold text-[1.1875rem] leading-tight">{title}</h1>
            {preview && <PreviewBadge />}
          </div>
          {description && <div className="max-w-2xl text-muted-foreground text-sm">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
      {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
    </header>
  );
}
