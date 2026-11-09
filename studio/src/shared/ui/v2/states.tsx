import Link from "next/link";
import type { ReactNode } from "react";
import { CircleAlertIcon, LockIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { NOT_AVAILABLE } from "@/shared/lib/format";

// Salarose empty state: an icon tile, one sentence that says why and what to do next, and at most
// one action.
export function RegionEmpty({ icon: Icon, message, action }: { icon: LucideIcon; message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <IconTile icon={Icon} />
      <p className="max-w-sm text-balance text-muted-foreground text-sm">{message}</p>
      {action}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-11 items-center justify-center rounded-tile bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-5" />
    </span>
  );
}

// A fixed sentence, never the server's error text (SHL-FR-12, SHL-FR-18).
export function RegionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <CircleAlertIcon aria-hidden className="size-5 text-destructive" />
      <p className="max-w-sm text-balance text-sm text-foreground">{message}</p>
      <Button onClick={onRetry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
}

// A skeleton block for a loading region. The caller sizes it to the loaded region's layout.
export function RegionSkeleton({ className }: { className?: string }) {
  return <Skeleton aria-hidden className={cn("rounded-lg motion-reduce:animate-none", className)} />;
}

// The loading state of a data table: the toolbar's height, then one bar per row, so nothing moves
// when the rows arrive.
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <RegionSkeleton className="mb-2 h-8 w-64 max-w-full" />
      {Array.from({ length: rows }, (_, row) => (
        <RegionSkeleton className="h-9" key={row} />
      ))}
    </div>
  );
}

// SHL-FR-17: a number the page could not compute says so and why, never 0.
export function NotAvailable({ reason }: { reason: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-muted-foreground">{NOT_AVAILABLE}</span>
      <span className="text-muted-foreground text-xs">{reason}</span>
    </span>
  );
}

// A whole page the viewer cannot open: a card with a heading, one sentence, and a way home.
function PageState({ mark, title, message }: { mark: ReactNode; title: string; message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-card border border-border bg-card px-6 py-12 text-center">
      {mark}
      <h2 className="font-heading font-semibold text-[1.0625rem]">{title}</h2>
      <p className="max-w-sm text-balance text-muted-foreground text-sm">{message}</p>
      <Button className="mt-1.5" render={<Link href="/v2" />} size="sm" variant="outline">
        Go to Home
      </Button>
    </div>
  );
}

// SHL-FR-03: the whole page an editor may not open.
// message says what the page holds, for a page whose board words its forbidden state.
export function Forbidden({ message = "Ask an admin if you need something from it." }: { message?: string }) {
  return <PageState mark={<IconTile icon={LockIcon} />} message={message} title="This page is for admins." />;
}

// SHL-FR-22: a route that does not exist, or a preview route the viewer may not reach. The two look
// the same, so a preview page does not reveal that it exists.
export function PageNotFound() {
  return (
    <PageState
      mark={<span className="font-heading font-semibold text-3xl text-muted-foreground tabular-nums">404</span>}
      message="The address may be wrong, or the page may have moved."
      title="We couldn't find that page."
    />
  );
}
