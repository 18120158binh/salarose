import { fireEvent, render, screen } from "@testing-library/react";
import { use } from "react";
import { DataRegion } from "../DataRegion";
import { RegionSkeleton } from "../states";

function Failing(): never {
  throw new Error("connect ECONNREFUSED 10.0.0.7:5432");
}

const pending = new Promise<never>(() => {});
function Waiting() {
  use(pending);
  return null;
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  // React logs every caught render error. The boundary under test is what handles it.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("DataRegion (SHL-FR-12)", () => {
  it("shows the skeleton while the region loads", () => {
    render(
      <DataRegion errorMessage="Journey numbers could not load" loading={<p>Loading journeys</p>}>
        <Waiting />
      </DataRegion>,
    );

    expect(screen.getByText("Loading journeys")).toBeInTheDocument();
  });

  it("shows the fixed sentence and Try again on failure, never the server's error text", () => {
    render(
      <DataRegion errorMessage="Journey numbers could not load" loading={<RegionSkeleton />}>
        <Failing />
      </DataRegion>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Journey numbers could not load");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("ECONNREFUSED");
  });

  it("keeps a sibling region loaded when one region fails", () => {
    render(
      <>
        <DataRegion errorMessage="Journey numbers could not load" loading={<RegionSkeleton />}>
          <Failing />
        </DataRegion>
        <DataRegion errorMessage="Journeys could not load" loading={<RegionSkeleton />}>
          <p>Welcome series</p>
        </DataRegion>
      </>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Journey numbers could not load");
    expect(screen.getByText("Welcome series")).toBeInTheDocument();
    expect(screen.queryByText("Journeys could not load")).not.toBeInTheDocument();
  });
});

describe("DataRegion Try again", () => {
  it("renders the region again, so a read that now succeeds replaces the error", async () => {
    let fail = true;
    function FailsOnce() {
      if (fail) throw new Error("canceling statement due to statement timeout");
      return <p>Welcome series</p>;
    }
    render(
      <DataRegion errorMessage="Journeys could not load" loading={<RegionSkeleton />}>
        <FailsOnce />
      </DataRegion>,
    );

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Welcome series")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
