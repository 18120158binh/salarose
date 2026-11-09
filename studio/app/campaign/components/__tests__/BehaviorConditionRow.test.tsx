import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import BehaviorConditionRow from "../node-editors/BehaviorConditionRow";

const purchase = { id: "ue_purchase", name: "purchase", label: "Purchase", fields: [{ value: "order.total", label: "Total", dataType: "number" }] };

// JBD-FR-02: a saved condition reloads with the same event, measure, window, operator, and value.
describe("BehaviorConditionRow", () => {
  it("shows the saved event, measure, window, operator, and value", () => {
    render(
      <BehaviorConditionRow
        condition={{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }}
        onChange={() => {}}
        events={[purchase]}
      />,
    );

    expect(screen.getByLabelText("Behavior event").textContent).toContain("Purchase");
    expect(screen.getByLabelText("Measure").textContent).toContain("Times performed");
    expect(screen.getByLabelText("Behavior operator").textContent).toContain("at least");
    expect(screen.getByLabelText("Behavior value")).toHaveValue(2);
    expect(screen.getByLabelText("Window unit").textContent).toContain("day(s)");
    expect(screen.getByLabelText("Window length")).toHaveValue(30);
  });

  // JBD-FR-14: the marketer states the window and never picks a metric id.
  it("asks for a window and offers no saved metric and no all-time window", async () => {
    render(
      <BehaviorConditionRow
        condition={{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 1 }}
        onChange={() => {}}
        events={[purchase]}
      />,
    );

    expect(screen.queryByLabelText("Saved property")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Window unit"));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(options).not.toContain("All time (Lifetime)");
    expect(options).toContain("In the last N day(s)");
  });
});
