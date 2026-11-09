import { fireEvent, render, screen } from "@testing-library/react";
import { InboxIcon } from "lucide-react";
import { Forbidden, PageNotFound, RegionEmpty, RegionError } from "../states";

describe("page states", () => {
  it("names what failed and retries on Try again (SHL-FR-12)", () => {
    const retry = jest.fn();
    render(<RegionError message="Journey numbers could not load" onRetry={retry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Journey numbers could not load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("says why a region is empty and offers the next step", () => {
    render(<RegionEmpty icon={InboxIcon} message="No journey is running." action={<button>Create journey</button>} />);

    expect(screen.getByText("No journey is running.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create journey" })).toBeInTheDocument();
  });

  it("tells an editor the page is for admins and links home (SHL-FR-03)", () => {
    render(<Forbidden />);

    expect(screen.getByText("This page is for admins.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/v2");
  });

  it("answers a missing or unreachable page the same way, with a way home (SHL-FR-22)", () => {
    render(<PageNotFound />);

    expect(screen.getByRole("heading", { name: "We couldn't find that page." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/v2");
  });
});
