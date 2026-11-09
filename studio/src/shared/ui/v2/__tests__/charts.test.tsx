import { fireEvent, render, screen, within } from "@testing-library/react";
import { BarChart, Sparkline, type ChartPoint } from "@/components/ui/chart";
import { periodChange, type Comparison, type GoodWhen } from "@/shared/lib/period-change";
import { KpiCard } from "../KpiCard";
import { KpiSparkline } from "../KpiSparkline";

const WEEK: ChartPoint[] = [
  { label: "Nov 1", value: 90 },
  { label: "Nov 2", value: 100 },
  { label: "Nov 3", value: 120 },
];

const BRANCHES: ChartPoint[] = [
  { label: "Yes", value: 1200 },
  { label: "No", value: 800 },
  { label: "Timed out", value: 40 },
];

const count = (value: number) => value.toLocaleString("en-US");

const RAW_COLOR =
  /(?:^|:)(?:bg|text|border|fill|stroke)-(?:white|black|gray|slate|zinc|neutral|red|orange|amber|yellow|green|emerald|blue|indigo|violet|purple|pink|rose)(?:-\d+)?(?:\/\d+)?$|#[0-9a-f]{3,8}\b/i;

function rawColors(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((element) =>
    (element.getAttribute("class") ?? "").split(/\s+/).filter((name) => RAW_COLOR.test(name)),
  );
}

function tooltipText(region: HTMLElement): string | null {
  return region.querySelector("[aria-hidden].pointer-events-none")?.textContent ?? null;
}

afterEach(() => {
  document.documentElement.className = "";
});

type Example = { name: string; comparison: Comparison; goodWhen: GoodWhen; label: string; tone: string };

// SHL-FR-16, the studio shell's acceptance examples.
const EXAMPLES: Example[] = [
  { name: "120 against 100", comparison: { kind: "count", current: 120, previous: 100 }, goodWhen: "up", label: "+20%", tone: "text-success" },
  { name: "5 against 0", comparison: { kind: "count", current: 5, previous: 0 }, goodWhen: "up", label: "New", tone: "text-success" },
  { name: "0 against 0", comparison: { kind: "count", current: 0, previous: 0 }, goodWhen: "up", label: "No change", tone: "text-muted-foreground" },
  { name: "a lag of 90 s against 60 s", comparison: { kind: "duration", current: 90, previous: 60 }, goodWhen: "down", label: "+50%", tone: "text-destructive" },
];

describe.each(["light", "dark"] as const)("KpiCard with a sparkline in the %s theme", (theme) => {
  it.each(EXAMPLES)("shows the change for $name with its color, sign, and the sparkline (SHL-FR-16)", (example) => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
    const { container } = render(
      <KpiCard
        change={periodChange(example.comparison, example.goodWhen)}
        definition="Customers who entered a journey in the range."
        label="Entries"
        trend={{ points: WEEK, unit: "count" }}
        value={{ available: true, value: "120" }}
      />,
    );

    const card = screen.getByRole("region", { name: "Entries" });
    expect(within(card).getByText(example.label).parentElement).toHaveClass(example.tone);
    const sparkline = within(card).getByRole("group", { name: "Entries per period" });
    const line = sparkline.querySelector("path");
    expect(line).toHaveClass("stroke-chart-1");
    expect(line?.getAttribute("d")).toMatch(/^M/);
    expect(rawColors(container)).toEqual([]);
  });
});

describe("KpiCard", () => {
  it("draws no sparkline when the value is not available (SHL-FR-17)", () => {
    render(
      <KpiCard
        change={null}
        definition="Customers who entered a journey in the range."
        label="Entries"
        trend={{ points: WEEK, unit: "count" }}
        value={{ available: false, reason: "The query timed out." }}
      />,
    );

    expect(screen.queryByRole("group", { name: "Entries per period" })).not.toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  function renderSparkline() {
    render(<Sparkline categoryLabel="Day" format={count} label="Entries per day" points={WEEK} valueLabel="Entries" />);
    return screen.getByRole("group", { name: "Entries per day" });
  }

  it("gives screen readers a table with the same numbers", () => {
    const region = renderSparkline();

    const table = within(region).getByRole("table", { name: "Entries per day" });
    expect(within(table).getByRole("columnheader", { name: "Day" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "Nov 3 120" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(WEEK.length + 1);
  });

  it("moves a tooltip with the exact value between points with the keyboard", () => {
    const region = renderSparkline();
    expect(tooltipText(region)).toBeNull();

    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(tooltipText(region)).toBe("Nov 1 90");
    fireEvent.keyDown(region, { key: "End" });
    expect(tooltipText(region)).toBe("Nov 3 120");
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(tooltipText(region)).toBe("Nov 2 100");
    fireEvent.keyDown(region, { key: "Escape" });
    expect(tooltipText(region)).toBeNull();
  });

  it("shows the tooltip of the point nearest the pointer", () => {
    const region = renderSparkline();
    region.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32, right: 200, bottom: 32, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerMove(region, { clientX: 190 });
    expect(tooltipText(region)).toBe("Nov 3 120");
    fireEvent.pointerLeave(region);
    expect(tooltipText(region)).toBeNull();
  });
});

describe("BarChart", () => {
  function renderBars() {
    const result = render(
      <BarChart categoryLabel="Branch" format={count} label="Customers per branch" points={BRANCHES} valueLabel="Customers" />,
    );
    return { ...result, region: screen.getByRole("group", { name: "Customers per branch" }) };
  }

  it("draws one chart-1 bar per point with rounded top corners and horizontal gridlines", () => {
    const { container, region } = renderBars();

    const bars = region.querySelectorAll("rect");
    expect(bars).toHaveLength(BRANCHES.length);
    bars.forEach((bar) => {
      expect(bar).toHaveClass("fill-chart-1");
      expect(bar).toHaveAttribute("rx", "2");
    });
    const gridlines = region.querySelectorAll("line");
    expect(gridlines.length).toBeGreaterThan(0);
    gridlines.forEach((line) => expect(line.getAttribute("y1")).toBe(line.getAttribute("y2")));
    expect(rawColors(container)).toEqual([]);
  });

  it("shows a bar's exact value on hover and on the keyboard, and the same numbers in a table", () => {
    const { region } = renderBars();

    fireEvent.pointerEnter(region.querySelectorAll("rect")[1] as Element);
    expect(tooltipText(region)).toBe("No 800");
    fireEvent.keyDown(region, { key: "Home" });
    expect(tooltipText(region)).toBe("Yes 1,200");
    expect(within(region).getByRole("row", { name: "Timed out 40" })).toBeInTheDocument();
  });
});

describe("KpiSparkline", () => {
  it("draws nothing with fewer than two points, so no empty chart takes focus", () => {
    const { container } = render(<KpiSparkline label="Entries" points={[{ label: "Nov 1", value: 3 }]} unit="count" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads a duration point in the duration format", () => {
    render(<KpiSparkline label="Engine lag" points={[{ label: "Nov 1", value: 2_000 }, { label: "Nov 2", value: 90_000 }]} unit="duration" />);
    expect(screen.getByRole("row", { name: "Nov 2 1 min 30 s" })).toBeInTheDocument();
  });
});
