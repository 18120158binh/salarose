import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventSchemaGateSwitch } from "../EventSchemaGateSwitch";
import { ExistingEventAttributeOutline } from "../ExistingEventAttributeOutline";
import { setUserEventSchemaEnforcementAction } from "@/app/actions";

jest.mock("@/app/actions", () => ({
  setUserEventSchemaEnforcementAction: jest.fn(async () => ({ success: true })),
}));

const toggle = jest.mocked(setUserEventSchemaEnforcementAction);

beforeEach(() => {
  toggle.mockClear();
  jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("EventSchemaGateSwitch", () => {
  it("turns the gate on after the admin confirms that failing events are dropped", async () => {
    const onChange = jest.fn();
    render(<EventSchemaGateSwitch enforced={false} eventId="ue_1" eventLabel="Add to cart" onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Enforce schema for Add to cart" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    expect(toggle).toHaveBeenCalledWith("ue_1", true);
  });

  it("keeps the gate off when the admin cancels", () => {
    jest.mocked(window.confirm).mockReturnValue(false);
    render(<EventSchemaGateSwitch enforced={false} eventId="ue_1" eventLabel="Add to cart" onChange={jest.fn()} />);

    fireEvent.click(screen.getByRole("switch", { name: "Enforce schema for Add to cart" }));

    expect(toggle).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Enforce schema for Add to cart" })).not.toBeChecked();
  });

  it("turns the gate off without asking", async () => {
    const onChange = jest.fn();
    render(<EventSchemaGateSwitch enforced eventId="ue_1" eventLabel="Add to cart" onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Enforce schema for Add to cart" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenCalledWith("ue_1", false);
  });

  it.each([
    ["is refused", () => toggle.mockResolvedValueOnce({ error: "Only admin users can do this." })],
    ["fails to reach the server", () => toggle.mockRejectedValueOnce(new Error("Failed to fetch"))],
  ])("shows an error and keeps the gate as it was when the change %s", async (_case, fail) => {
    fail();
    const onChange = jest.fn();
    render(<EventSchemaGateSwitch enforced={false} eventId="ue_1" eventLabel="Add to cart" onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Enforce schema for Add to cart" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    const control = screen.getByRole("switch", { name: "Enforce schema for Add to cart" });
    expect(control).not.toBeChecked();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("the required flag in the attribute outline", () => {
  it("shows each attribute's flag and reports a change with the attribute path", () => {
    const onRequiredChange = jest.fn();
    render(
      <ExistingEventAttributeOutline
        createForm={null}
        createFormParentPath={null}
        editingField={null}
        fields={[
          { value: "product", label: "Product", dataType: "json", required: true },
          { value: "product.price", label: "Price", dataType: "number", required: false },
        ]}
        isCreateFormOpen={false}
        itemKey={null}
        onAdd={jest.fn()}
        onCancelEdit={jest.fn()}
        onDelete={jest.fn()}
        onEditChange={jest.fn()}
        onRequiredChange={onRequiredChange}
        onSaveEdit={jest.fn()}
        onStartEdit={jest.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "product required" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "product.price required" }));

    expect(onRequiredChange).toHaveBeenCalledWith("product.price", true);
  });
});
