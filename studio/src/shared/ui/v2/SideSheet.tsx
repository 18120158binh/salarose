"use client";

import type { ReactNode } from "react";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// DESIGN.md side sheets: 480px for a row's detail, 640px for a form with a preview.
export type SideSheetSize = "detail" | "form";

const WIDTH: Record<SideSheetSize, string> = {
  detail: "max-w-[480px]",
  form: "max-w-[640px]",
};

export interface SideSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: SideSheetSize;
  // The actions, primary last so it sits on the right.
  footer?: ReactNode;
  children: ReactNode;
}

// Opens from the right, full height. Escape and a click outside close it.
export function SideSheet({ open, onOpenChange, title, description, size = "detail", footer, children }: SideSheetProps) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup
        backdropProps={{ className: "backdrop-blur-none" }}
        className={cn("bg-background", WIDTH[size])}
        side="right"
      >
        <SheetHeader className="border-border border-b pe-12">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <SheetPanel className="pt-6">{children}</SheetPanel>
        {footer && (
          <SheetFooter className="border-border border-t py-4" variant="bare">
            {footer}
          </SheetFooter>
        )}
      </SheetPopup>
    </Sheet>
  );
}
