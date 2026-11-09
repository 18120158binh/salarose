import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// A number column is right-aligned with tabular figures. Everything else is text, left-aligned.
export type ColumnKind = "text" | "number";

export interface Column<Row> {
  id: string;
  header: string;
  kind?: ColumnKind;
  cell: (row: Row) => ReactNode;
}

// What a click on a row opens. The first column's cell becomes the link or button, stretched over
// the whole row, so the row is one click target that the keyboard reaches too. A row whose href is
// null opens nothing, such as a page the viewer may not open.
export type RowOpen<Row> =
  | { kind: "link"; href: (row: Row) => string | null }
  | { kind: "action"; onOpen: (row: Row) => void };

type RowTarget = { kind: "link"; href: string } | { kind: "action"; onOpen: () => void };

function targetOf<Row>(open: RowOpen<Row> | undefined, row: Row): RowTarget | null {
  if (open === undefined) return null;
  if (open.kind === "action") return { kind: "action", onOpen: () => open.onOpen(row) };
  const href = open.href(row);
  return href === null ? null : { kind: "link", href };
}

export interface DataTableProps<Row> {
  // The table's accessible name, such as "Journeys".
  label: string;
  columns: readonly [Column<Row>, ...Column<Row>[]];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  // SHL-FR-12: every region says why it is empty. Shown inside the card instead of the rows.
  empty: ReactNode;
  open?: RowOpen<Row>;
  // A trailing menu button per row. It sits above the stretched row link, so both stay clickable.
  rowActions?: (row: Row) => ReactNode;
  // Search, filters, and sort, above the table.
  toolbar?: ReactNode;
  // Paging, below the table. Usually a TablePager.
  footer?: ReactNode;
  // The key of a row to mark as the current one and scroll into view, such as a link's target.
  selectedKey?: string;
}

function scrollToRow(row: HTMLTableRowElement | null) {
  row?.scrollIntoView({ block: "center" });
}

const STRETCH = "after:absolute after:inset-0 after:content-['']";
const FOCUS = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  empty,
  open,
  rowActions,
  toolbar,
  footer,
  selectedKey,
}: DataTableProps<Row>) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-card text-card-foreground">
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-border border-b p-3">{toolbar}</div>}
      {rows.length === 0 ? (
        empty
      ) : (
        <Table
          aria-label={label}
          containerClassName={cn(
            "max-h-[70vh] scroll-pt-10 overflow-y-auto",
            !open && "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
          // Without row links the keyboard has nothing to stop on inside the scroller, so the
          // scroller itself takes focus and scrolls with the arrow keys.
          containerProps={open ? undefined : { tabIndex: 0, role: "region", "aria-label": label }}
        >
          <TableHeader>
            <TableRow className="border-0 hover:bg-transparent">
              {columns.map((column) => (
                <TableHead
                  className={cn(
                    // A sticky cell loses its collapsed border, so an inset shadow draws the line.
                    "sticky top-0 z-20 bg-card px-3 font-semibold text-muted-foreground text-xs shadow-[inset_0_-1px_var(--border)] first:pl-4",
                    column.kind === "number" && "text-right",
                  )}
                  key={column.id}
                  scope="col"
                >
                  {column.header}
                </TableHead>
              ))}
              {rowActions && (
                <TableHead className="sticky top-0 z-20 w-px bg-card shadow-[inset_0_-1px_var(--border)]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const target = targetOf(open, row);
              const key = rowKey(row);
              const selected = key === selectedKey;
              return (
                <TableRow
                  aria-current={selected ? "true" : undefined}
                  className={cn("h-11", target && "cursor-pointer", selected && "shadow-[inset_3px_0_var(--primary)]")}
                  data-state={selected ? "selected" : undefined}
                  key={key}
                  ref={selected ? scrollToRow : undefined}
                >
                  {columns.map((column, index) => (
                    <TableCell
                      className={cn("px-3 first:pl-4", column.kind === "number" && "text-right tabular-nums")}
                      key={column.id}
                    >
                      {index === 0 && target ? <OpenTarget target={target}>{column.cell(row)}</OpenTarget> : column.cell(row)}
                    </TableCell>
                  ))}
                  {rowActions && <TableCell className="relative z-10 w-px px-2 text-right">{rowActions(row)}</TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {footer && <div className="border-border border-t p-3">{footer}</div>}
    </div>
  );
}

function OpenTarget({ target, children }: { target: RowTarget; children: ReactNode }) {
  switch (target.kind) {
    case "link":
      return (
        <Link className={cn(STRETCH, FOCUS)} href={target.href}>
          {children}
        </Link>
      );
    case "action":
      return (
        <button className={cn(STRETCH, FOCUS, "text-left")} onClick={target.onOpen} type="button">
          {children}
        </button>
      );
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

// The main label of a row with an id or a system name as secondary text under it.
export function CellLabel({ label, secondary }: { label: string; secondary?: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {secondary && <span className="font-mono text-muted-foreground text-xs">{secondary}</span>}
    </span>
  );
}

export interface TablePagerProps {
  // 1-based.
  page: number;
  pageCount: number;
  href: (page: number) => string;
}

// Paging through the address, so a page is a link the server renders and the back button works.
export function TablePager({ page, pageCount, href }: TablePagerProps) {
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-muted-foreground text-sm">
      <span>
        Page {page} of {pageCount}
      </span>
      <div className="flex gap-2">
        <PagerLink disabled={page <= 1} href={href(page - 1)}>
          <ChevronLeftIcon aria-hidden />
          Previous
        </PagerLink>
        <PagerLink disabled={page >= pageCount} href={href(page + 1)}>
          Next
          <ChevronRightIcon aria-hidden />
        </PagerLink>
      </div>
    </nav>
  );
}

function PagerLink({ disabled, href, children }: { disabled: boolean; href: string; children: ReactNode }) {
  if (disabled) {
    return (
      <Button disabled size="sm" variant="outline">
        {children}
      </Button>
    );
  }
  return (
    <Button render={<Link href={href} />} size="sm" variant="outline">
      {children}
    </Button>
  );
}
