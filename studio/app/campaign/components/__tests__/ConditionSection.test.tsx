import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import ConditionSection from "../node-editors/ConditionSection";
import { FieldDef } from "@/entities/journey/model/conditionConfig";
import type { PersonCondition } from "@/entities/journey/model/types";

const eventFields: FieldDef[] = [
  { value: "product.price", label: "Price", group: "event", type: "number" },
  { value: "product.brand", label: "Brand", group: "event", type: "string" },
  { value: "product.category", label: "Category", group: "event", type: "string" },
];
const profileFields: FieldDef[] = [
  { value: "city", label: "City", group: "user", type: "string" },
];
const addToCart = { id: "ue_1", name: "add_to_cart", label: "Add to Cart", fields: [] };

const priceRow = { type: "event_property", field: "product.price", op: ">", value: 500000 } as const;
const brandRow = { type: "event_property", field: "product.brand", op: "=", value: "acme" } as const;
const defaultRow = { type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true } as const;

function renderSection(props: Partial<React.ComponentProps<typeof ConditionSection>>) {
  render(
    <ConditionSection
      onFiltersChange={() => {}}
      onConditionsChange={() => {}}
      availableEventFields={eventFields}
      availableProfileFields={profileFields}
      events={[addToCart]}
      isEventSelected
      {...props}
    />,
  );
}

describe("ConditionSection event filters", () => {
  it("adds an OR condition inside the group the marketer picks", () => {
    const onFiltersChange = jest.fn();
    renderSection({ filters: { groups: [{ conditions: [priceRow] }] }, onFiltersChange });

    fireEvent.click(within(screen.getAllByRole("group")[0]).getByText("+ Or event property"));

    expect(onFiltersChange).toHaveBeenLastCalledWith({
      groups: [{ conditions: [priceRow, { type: "event_property", field: "product.price", op: "=", value: "" }] }],
    });
  });

  it("adds an AND group next to the others", () => {
    const onFiltersChange = jest.fn();
    renderSection({ filters: { groups: [{ conditions: [priceRow] }] }, onFiltersChange });

    fireEvent.click(screen.getAllByText("+ And event property")[0]);

    expect(onFiltersChange).toHaveBeenLastCalledWith({
      groups: [
        { conditions: [priceRow] },
        { conditions: [{ type: "event_property", field: "product.price", op: "=", value: "" }] },
      ],
    });
  });

  it("deletes a group with its last condition, so no group is left empty", () => {
    const onFiltersChange = jest.fn();
    renderSection({ filters: { groups: [{ conditions: [priceRow] }, { conditions: [brandRow] }] }, onFiltersChange });

    fireEvent.click(within(screen.getAllByRole("group")[1]).getByLabelText("Delete condition"));

    expect(onFiltersChange).toHaveBeenLastCalledWith({ groups: [{ conditions: [priceRow] }] });
  });

  it("saves IN as a list", () => {
    const onFiltersChange = jest.fn();
    renderSection({
      filters: { groups: [{ conditions: [{ type: "event_property", field: "product.brand", op: "IN", value: ["acme"] }] }] },
      onFiltersChange,
    });

    fireEvent.change(screen.getByDisplayValue("acme"), { target: { value: "acme, apple" } });

    expect(onFiltersChange).toHaveBeenLastCalledWith({
      groups: [{ conditions: [{ type: "event_property", field: "product.brand", op: "IN", value: ["acme", "apple"] }] }],
    });
  });

  it("shows catalog default rows locked", () => {
    renderSection({ filters: { groups: [{ conditions: [defaultRow] }, { conditions: [brandRow] }] } });

    expect(screen.getByText("Category").closest("button")).toHaveAttribute("disabled");
    expect(screen.getByText("Brand").closest("button")).not.toHaveAttribute("disabled");
  });
});

describe("ConditionSection person conditions", () => {
  it("ORs a behavior condition with a profile field in one group", () => {
    const onConditionsChange = jest.fn();
    const city: PersonCondition = { type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] };
    renderSection({ isEventSelected: false, conditions: { groups: [{ conditions: [city] }] }, onConditionsChange });

    fireEvent.click(within(screen.getAllByRole("group")[0]).getByText("+ Or behavior"));

    expect(onConditionsChange).toHaveBeenLastCalledWith({
      groups: [{
        conditions: [
          city,
          { type: "behavior", event: "", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 1 },
        ],
      }],
    });
  });
});
