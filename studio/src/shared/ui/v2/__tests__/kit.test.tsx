import { render, screen } from "@testing-library/react";
import { PageHeader } from "../PageHeader";
import { SectionCard } from "../SectionCard";
import { StatusBadge } from "../StatusBadge";

describe("page kit", () => {
  it("shows a status as an icon and a word, never color alone", () => {
    const { container } = render(<StatusBadge tone="warning">Paused</StatusBadge>);

    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("marks a preview page next to its title (SHL-FR-22)", () => {
    render(<PageHeader preview title="Settings" />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("shows no Preview badge on a shipped page", () => {
    render(<PageHeader title="Journeys" />);

    expect(screen.queryByText("Preview")).toBeNull();
  });

  it("names a card by its title and keeps its actions beside it", () => {
    render(
      <SectionCard actions={<button type="button">Open monitoring</button>} title="Data health">
        <p>9 receiving</p>
      </SectionCard>,
    );

    const card = screen.getByRole("region", { name: "Data health" });
    expect(card).toHaveTextContent("9 receiving");
    expect(screen.getByRole("button", { name: "Open monitoring" })).toBeInTheDocument();
  });
});
