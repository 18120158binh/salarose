import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import TriggerNodeEditor from "../node-editors/TriggerNodeEditor";

const viewProduct = {
  id: "evt-view-product",
  name: "view_product",
  label: "View Product",
  fields: [
    { value: "product.price", label: "Price", dataType: "number" },
    { value: "product.brand", label: "Brand", dataType: "string" },
    { value: "product.in_stock", label: "In Stock", dataType: "boolean" },
    { value: "product.released_at", label: "Released At", dataType: "datetime" },
  ],
};

function renderSetupEditor(conditionRow: { field: string; op: string; value: string | number }) {
  render(
    <TriggerNodeEditor
      config={{
        eventId: viewProduct.id,
        triggerEventName: viewProduct.name,
        filters: { groups: [{ conditions: [{ type: "event_property", ...conditionRow }] }] },
      }}
      handleFieldChange={() => {}}
      userEvents={[viewProduct]}
      businessEvents={[]}
      userProfileFields={[]}
    />,
  );
  const conditionsTab = screen.getByRole("tab", { name: "Conditions" });
  fireEvent.pointerDown(conditionsTab);
  fireEvent.click(conditionsTab);
}

async function operatorLabels(currentOperatorLabel: string): Promise<string[]> {
  fireEvent.click(screen.getByText(currentOperatorLabel));
  const listbox = await screen.findByRole("listbox");
  return within(listbox).getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("TriggerNodeEditor event conditions", () => {
  it("offers numeric operators for a numeric catalog attribute", async () => {
    renderSetupEditor({ field: "product.price", op: "=", value: 500000 });

    expect(await operatorLabels("equals")).toEqual([
      "equals",
      "does not equal",
      "is at least",
      "is more than",
      "is at most",
      "is less than",
    ]);
  });

  it("offers text operators for a text catalog attribute", async () => {
    renderSetupEditor({ field: "product.brand", op: "=", value: "acme" });

    expect(await operatorLabels("equals")).toEqual([
      "equals",
      "does not equal",
      "contains",
      "is one of",
    ]);
  });

  it("offers equality with true or false for a boolean catalog attribute", async () => {
    renderSetupEditor({ field: "product.in_stock", op: "=", value: "true" });

    expect(screen.queryByPlaceholderText("enter value...")).toBeNull();
    expect(await operatorLabels("equals")).toEqual(["equals", "does not equal"]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    fireEvent.click(screen.getByText("true"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "true",
      "false",
    ]);
  });

  // The decision job orders two ISO 8601 datetimes in time (JBD-FR-06).
  it("offers before and after for a datetime catalog attribute", async () => {
    renderSetupEditor({ field: "product.released_at", op: "=", value: "2026-10-01" });

    expect(await operatorLabels("equals")).toEqual([
      "equals",
      "does not equal",
      "is on or after",
      "is after",
      "is on or before",
      "is before",
    ]);
  });
});
