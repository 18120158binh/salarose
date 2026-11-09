import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import SegmentNodeEditor from "../node-editors/SegmentNodeEditor";

// A segment fires only yes, so its editor offers only the Yes path. A segment saved by an older
// build with a No path opens with a warning that the No path never runs.
function renderPaths(checkType: string) {
  render(
    <SegmentNodeEditor
      config={{ checkType }}
      handleFieldChange={() => {}}
      onUpdate={() => {}}
      label="Buyers"
    />,
  );
  const pathsTab = screen.getByRole("tab", { name: "Paths" });
  fireEvent.pointerDown(pathsTab);
  fireEvent.click(pathsTab);
}

async function pathOptions(): Promise<string[]> {
  fireEvent.click(screen.getByRole("combobox"));
  const listbox = await screen.findByRole("listbox");
  return within(listbox)
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-disabled") !== "true")
    .map((option) => option.textContent ?? "");
}

describe("SegmentNodeEditor paths", () => {
  it("offers only the Yes path", async () => {
    renderPaths("YesPath");

    expect(await pathOptions()).toEqual(["Yes Only (If match)"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["NoPath", "YesOrNoPath"])("warns that the No path of an older %s segment never runs", async (checkType) => {
    renderPaths(checkType);

    expect(screen.getByRole("alert").textContent).toMatch(/never take No/);
    expect(await pathOptions()).toEqual(["Yes Only (If match)"]);
  });
});
