import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
  // The card's heading, also its accessible name.
  title: string;
  description?: ReactNode;
  // Buttons or links at the right of the heading.
  actions?: ReactNode;
  // Drop the body padding, for a table or a list that runs to the card's edges.
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

// Salarose card: surface-200 on the page ground, a hairline border, radius-card, a 15px title.
export function SectionCard({ title, description, actions, flush = false, className, children }: SectionCardProps) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col rounded-card border border-border bg-card text-card-foreground", className)}>
      <div className="flex flex-wrap items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="font-heading font-semibold text-[0.9375rem] leading-snug">{title}</h2>
          {description && <div className="text-muted-foreground text-xs">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={cn("flex min-w-0 flex-col", !flush && "px-4 pb-4")}>{children}</div>
    </section>
  );
}
