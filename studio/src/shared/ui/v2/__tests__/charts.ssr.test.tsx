/**
 * @jest-environment node
 */
import { renderToString } from "react-dom/server";
import { BarChart, Sparkline } from "@/components/ui/chart";

const POINTS = [
  { label: "Nov 1", value: 3 },
  { label: "Nov 2", value: 5 },
];

// The charts are drawn on the server, so a KPI row shows its lines before any script runs.
describe("charts rendered on the server", () => {
  it("draws the sparkline's line", () => {
    const html = renderToString(<Sparkline categoryLabel="Day" label="Entries per day" points={POINTS} valueLabel="Entries" />);
    expect(html).toMatch(/<path[^>]* d="M/);
  });

  it("draws the bar chart's bars", () => {
    const html = renderToString(<BarChart categoryLabel="Branch" label="Customers per branch" points={POINTS} valueLabel="Customers" />);
    expect(html.match(/<rect/g)).toHaveLength(POINTS.length);
  });
});
