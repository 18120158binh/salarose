import { act, fireEvent, render, screen, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { InboxIcon } from "lucide-react";
import { ToastProvider } from "@/components/ui/toast";
import { DataTable, CellLabel, TablePager, type Column } from "../DataTable";
import { KpiCard } from "../KpiCard";
import { PageHeader } from "../PageHeader";
import { SideSheet } from "../SideSheet";
import { StatusBadge } from "../StatusBadge";
import { RegionEmpty } from "../states";
import { notify } from "../toast";

type Journey = { id: string; name: string; status: "Active" | "Paused"; entries: number };

const JOURNEYS: Journey[] = [
  { id: "j-1", name: "Welcome series", status: "Active", entries: 12480 },
  { id: "j-2", name: "Win back", status: "Paused", entries: 310 },
];

const COLUMNS: [Column<Journey>, ...Column<Journey>[]] = [
  { id: "name", header: "Journey", cell: (row) => <CellLabel label={row.name} secondary={row.id} /> },
  {
    id: "status",
    header: "Status",
    cell: (row) => <StatusBadge tone={row.status === "Active" ? "success" : "warning"}>{row.status}</StatusBadge>,
  },
  { id: "entries", header: "Entries", kind: "number", cell: (row) => row.entries.toLocaleString("en-US") },
];

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

// DESIGN.md dark mode: every app pattern renders in both themes from tokens alone. A palette color
// or a hex value in a class would stay the same when `.dark` switches the tokens.
const RAW_COLOR =
  /(?:^|:)(?:bg|text|border|ring|fill|stroke|from|to|via|shadow)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?(?:\/\d+)?$|#[0-9a-f]{3,8}\b/i;

function renderInTheme(ui: ReactElement, theme: Theme): RenderResult {
  document.documentElement.className = theme === "dark" ? "dark" : "";
  return render(ui);
}

function rawColorClasses(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((element) =>
    (element.getAttribute("class") ?? "").split(/\s+/).filter((name) => RAW_COLOR.test(name)),
  );
}

const EMPTY = <RegionEmpty icon={InboxIcon} message="No journey is running." />;

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

afterEach(() => {
  document.documentElement.className = "";
});

describe.each(THEMES)("app patterns in the %s theme", (theme) => {
  it("renders the page header with its actions and controls from tokens alone", () => {
    const { container } = renderInTheme(
      <PageHeader
        actions={<button type="button">Open classic</button>}
        controls={<button type="button">Last 7 days</button>}
        description="How each journey performs."
        title="Journeys"
      />,
      theme,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Journeys" })).toBeInTheDocument();
    expect(screen.getByText("How each journey performs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeInTheDocument();
    expect(rawColorClasses(container)).toEqual([]);
  });

  it("renders the data table with a sticky header, numbers right-aligned, and icon-and-word statuses from tokens alone", () => {
    const { container } = renderInTheme(
      <DataTable columns={COLUMNS} empty={EMPTY} label="Journeys" rowKey={(row) => row.id} rows={JOURNEYS} />,
      theme,
    );

    const table = screen.getByRole("table", { name: "Journeys" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Journey", "Status", "Entries"]);
    headers.forEach((header) => expect(header).toHaveClass("sticky", "top-0"));
    expect(headers[2]).toHaveClass("text-right");
    expect(screen.getByText("12,480").closest("td")).toHaveClass("text-right", "tabular-nums");
    expect(screen.getByText("Active")).toHaveClass("text-success");
    expect(screen.getByText("Paused")).toHaveClass("text-warning");
    expect(rawColorClasses(container)).toEqual([]);
  });

  it("renders the KPI card with its value and change from tokens alone", () => {
    const { container } = renderInTheme(
      <KpiCard
        change={{ label: "+20%", direction: "up", tone: "good" }}
        definition="Customers who entered a journey in the range."
        label="Entries"
        value={{ available: true, value: "120" }}
      />,
      theme,
    );

    const card = screen.getByRole("region", { name: "Entries" });
    expect(within(card).getByText("120")).toBeInTheDocument();
    expect(within(card).getByText("+20%").parentElement).toHaveClass("text-success");
    expect(rawColorClasses(container)).toEqual([]);
  });

  it("renders the side sheet with its title, body, and footer from tokens alone", () => {
    renderInTheme(
      <SideSheet footer={<button type="button">Open in classic</button>} onOpenChange={() => {}} open title="Welcome series">
        <p>Entries this week</p>
      </SideSheet>,
      theme,
    );

    const sheet = screen.getByRole("dialog", { name: "Welcome series" });
    expect(within(sheet).getByText("Entries this week")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Open in classic" })).toBeInTheDocument();
    expect(sheet).toHaveClass("max-w-[480px]", "bg-background");
    expect(rawColorClasses(sheet)).toEqual([]);
  });

  it("renders a toast from tokens alone", async () => {
    render(<ToastProvider />);

    act(() => void notify({ kind: "done", title: "Copied" }));

    const toast = await screen.findByText("Copied");
    expect(rawColorClasses(toast.closest('[data-slot="toast-viewport"]')!)).toEqual([]);
  });
});

describe("DataTable", () => {
  it("shows the empty state inside the card instead of an empty table (SHL-FR-12)", () => {
    render(<DataTable columns={COLUMNS} empty={EMPTY} label="Journeys" rowKey={(row) => row.id} rows={[]} />);

    expect(screen.getByText("No journey is running.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("makes each row a link through its first cell when rows open a page", () => {
    render(
      <DataTable
        columns={COLUMNS}
        empty={EMPTY}
        label="Journeys"
        open={{ kind: "link", href: (row) => `/v2/journeys/${row.id}` }}
        rowKey={(row) => row.id}
        rows={JOURNEYS}
      />,
    );

    expect(screen.getByRole("link", { name: /Welcome series/ })).toHaveAttribute("href", "/v2/journeys/j-1");
    expect(screen.getByRole("link", { name: /Win back/ })).toHaveAttribute("href", "/v2/journeys/j-2");
  });

  it("lets the keyboard stop on the table, as a labelled region, when rows open nothing", () => {
    render(<DataTable columns={COLUMNS} empty={EMPTY} label="Journeys" rowKey={(row) => row.id} rows={JOURNEYS} />);

    expect(screen.getByRole("region", { name: "Journeys" })).toHaveAttribute("tabindex", "0");
  });

  it("leaves the keyboard to the row links, with no extra stop, when rows open a page", () => {
    render(
      <DataTable
        columns={COLUMNS}
        empty={EMPTY}
        label="Journeys"
        open={{ kind: "link", href: (row) => `/v2/journeys/${row.id}` }}
        rowKey={(row) => row.id}
        rows={JOURNEYS}
      />,
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Journeys" }).parentElement).not.toHaveAttribute("tabindex");
  });

  it("opens the clicked row when rows open in place, and keeps row actions separate", () => {
    const opened: string[] = [];
    const acted: string[] = [];
    render(
      <DataTable
        columns={COLUMNS}
        empty={EMPTY}
        label="Journeys"
        open={{ kind: "action", onOpen: (row) => opened.push(row.id) }}
        rowActions={(row) => (
          <button onClick={() => acted.push(row.id)} type="button">
            More for {row.name}
          </button>
        )}
        rowKey={(row) => row.id}
        rows={JOURNEYS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Win back/ }));
    fireEvent.click(screen.getByRole("button", { name: "More for Welcome series" }));

    expect(opened).toEqual(["j-2"]);
    expect(acted).toEqual(["j-1"]);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("renders the toolbar above and the pager below the rows", () => {
    render(
      <DataTable
        columns={COLUMNS}
        empty={EMPTY}
        footer={<TablePager href={(page) => `/v2/journeys?page=${page}`} page={2} pageCount={3} />}
        label="Journeys"
        rowKey={(row) => row.id}
        rows={JOURNEYS}
        toolbar={<input aria-label="Search journeys" />}
      />,
    );

    const search = screen.getByRole("textbox", { name: "Search journeys" });
    const table = screen.getByRole("table");
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(search.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(table.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("TablePager", () => {
  it("names the page and links both neighbours", () => {
    render(<TablePager href={(page) => `/v2/journeys?page=${page}`} page={2} pageCount={3} />);

    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/v2/journeys?page=1");
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/v2/journeys?page=3");
  });

  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(<TablePager href={(page) => `?page=${page}`} page={1} pageCount={2} />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Next" })).toBeInTheDocument();

    rerender(<TablePager href={(page) => `?page=${page}`} page={2} pageCount={2} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("KpiCard", () => {
  it("shows Not available and the reason, never 0, when the value cannot be computed (SHL-FR-17)", () => {
    render(
      <KpiCard
        change={{ label: "+20%", direction: "up", tone: "good" }}
        definition="Messages the platform asked a channel to send."
        label="Messages requested"
        value={{ available: false, reason: "The message log is not connected yet." }}
      />,
    );

    const card = screen.getByRole("region", { name: "Messages requested" });
    expect(within(card).getByText("Not available")).toBeInTheDocument();
    expect(within(card).getByText("The message log is not connected yet.")).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/\b0\b/);
    expect(within(card).queryByText("+20%")).not.toBeInTheDocument();
  });

  it("colors a bad move red and shows no arrow for no change", () => {
    const { rerender } = render(
      <KpiCard change={{ label: "+50%", direction: "up", tone: "bad" }} definition="Lag." label="Lag p95" value={{ available: true, value: "90 s" }} />,
    );
    expect(screen.getByText("+50%").parentElement).toHaveClass("text-destructive");

    rerender(
      <KpiCard change={{ label: "No change", direction: "flat", tone: "neutral" }} definition="Lag." label="Lag p95" value={{ available: true, value: "0 s" }} />,
    );
    const line = screen.getByText("No change").parentElement!;
    expect(line).toHaveClass("text-muted-foreground");
    expect(line.querySelector("svg")).toBeNull();
  });

  it("gives the definition behind a keyboard-reachable info button", () => {
    render(<KpiCard change={null} definition="Customers who entered." label="Entries" value={{ available: true, value: "5" }} />);

    expect(screen.getByRole("button", { name: "What Entries means" })).toBeInTheDocument();
  });
});

describe("SideSheet", () => {
  it("closes on Escape", () => {
    const onOpenChange = jest.fn();
    render(
      <SideSheet onOpenChange={onOpenChange} open title="Welcome series">
        <p>Body</p>
      </SideSheet>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("is 640px wide for a form with a preview", () => {
    render(
      <SideSheet onOpenChange={() => {}} open size="form" title="Edit">
        <p>Body</p>
      </SideSheet>,
    );

    expect(screen.getByRole("dialog")).toHaveClass("max-w-[640px]");
  });
});
