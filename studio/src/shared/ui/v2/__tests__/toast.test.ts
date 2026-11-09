import { toastManager } from "@/components/ui/toast";
import { notify } from "../toast";

let mockAdd: jest.SpyInstance;
beforeEach(() => {
  mockAdd = jest.spyOn(toastManager, "add").mockReturnValue("toast-id");
});
afterEach(() => mockAdd.mockRestore());

describe("notify (SHL-FR-13)", () => {
  it("closes an outcome after 5 seconds", () => {
    notify({ kind: "done", title: "Copied" });

    expect(mockAdd).toHaveBeenCalledWith({ title: "Copied", type: "success", timeout: 5000 });
  });

  it("keeps an error until the viewer closes it", () => {
    notify({ kind: "failed", title: "Could not copy" });

    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not copy", type: "error", timeout: 0 }));
  });

  it("keeps a toast with an action until the viewer closes it", () => {
    const undo = jest.fn();
    notify({ kind: "action", title: "Filter cleared", action: { label: "Undo", onClick: undo } });

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 0, actionProps: { children: "Undo", onClick: undo } }),
    );
  });
});
