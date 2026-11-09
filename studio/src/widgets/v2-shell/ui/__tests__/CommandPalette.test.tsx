import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { SystemRole } from "@/shared/auth/types";
import type { NameSearch } from "../../model/palette";
import { mayReach, NAV } from "../../model/routes";
import { CommandPalette, type SearchNames } from "../CommandPalette";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

const CART: NameSearch = {
  status: "found",
  journeys: [{ id: "CAMP-4f1c9a0b2d3e5f67", name: "Cart abandonment" }],
  segments: [{ id: "SEG-4f1c9a0b2d3e5f67", name: "Cart builders" }],
};

function renderPalette({
  role = "editor",
  preview = false,
  search = async () => CART,
}: { role?: SystemRole; preview?: boolean; search?: SearchNames } = {}) {
  return render(<CommandPalette search={search} viewer={{ role, preview }} />);
}

async function pressShortcut(init: KeyboardEventInit = { ctrlKey: true }) {
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", ...init });
  });
}

async function type(text: string) {
  const input = screen.getByRole("combobox");
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
}

// The dialog leaves the page once its closing animation ends.
async function expectClosed() {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
}

const optionNames = () => screen.queryAllByRole("option").map((option) => option.textContent);

describe("CommandPalette (SHL-FR-07)", () => {
  it("opens with Ctrl+K and with Cmd+K, and closes with Escape", async () => {
    renderPalette();

    await pressShortcut({ ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search studio" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    });
    await expectClosed();

    await pressShortcut({ metaKey: true });
    expect(screen.getByRole("dialog", { name: "Search studio" })).toBeInTheDocument();
  });

  it("opens from the top bar button", async () => {
    renderPalette();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search or jump to…" }));
    });
    expect(screen.getByRole("dialog", { name: "Search studio" })).toBeInTheDocument();
  });

  it("offers the journey for CART, and Enter opens its analytics page", async () => {
    const search = jest.fn(async () => CART);
    renderPalette({ search });
    await pressShortcut();

    await type("CART");

    expect(search).toHaveBeenCalledWith("CART");
    expect(optionNames()).toEqual(["Cart abandonment", "Cart builders", 'Look up customer "CART"']);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    });
    expect(mockPush).toHaveBeenCalledWith("/v2/journeys/CAMP-4f1c9a0b2d3e5f67");
    await expectClosed();
  });

  it("moves with the arrow keys and opens the segment list with the segment selected", async () => {
    renderPalette();
    await pressShortcut();
    await type("cart");

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    });
    expect(mockPush).toHaveBeenCalledWith("/v2/segments?segment=SEG-4f1c9a0b2d3e5f67");
  });

  it("looks up a customer by the typed text", async () => {
    renderPalette({ search: async () => ({ status: "found", journeys: [], segments: [] }) });
    await pressShortcut();
    await type("user-42");

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: 'Look up customer "user-42"' }));
    });
    expect(mockPush).toHaveBeenCalledWith("/v2/customers?q=user-42");
  });

  it("still offers the pages when the search fails, and says so", async () => {
    renderPalette({ search: async () => Promise.reject(new Error("down")) });
    await pressShortcut();
    await type("home");

    expect(optionNames()).toEqual(["Home", 'Look up customer "home"']);
    expect(screen.getByRole("status")).toHaveTextContent("Journeys and segments could not load.");
  });

  it("never shows an answer for text that has since changed", async () => {
    const search = jest.fn((text: string) => (text === "car" ? new Promise<NameSearch>(() => {}) : Promise.resolve(CART)));
    renderPalette({ search });
    await pressShortcut();
    await type("cart");
    await type("car");

    expect(optionNames()).toEqual(['Look up customer "car"']);
    expect(screen.getByRole("status")).toHaveTextContent("Searching journeys and segments…");
  });
});

describe("CommandPalette pages (SHL-FR-04)", () => {
  it("offers an editor no Sources, Dropped data, or Platform page", async () => {
    renderPalette({ role: "editor" });
    await pressShortcut();

    const list = screen.getByRole("listbox");
    expect(within(list).queryByRole("option", { name: "Platform" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: "Sources" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: "Dropped data" })).not.toBeInTheDocument();
    const editor = { role: "editor", preview: false } as const;
    expect(optionNames()).toEqual(NAV.filter((entry) => entry.section !== "menu" && mayReach(entry, editor)).map((entry) => entry.label));
  });

  it("offers an admin Settings with its Preview badge (SHL-FR-22)", async () => {
    renderPalette({ role: "admin", preview: true });
    await pressShortcut();

    expect(within(screen.getByRole("option", { name: /^Settings/ })).getByText("Preview")).toBeInTheDocument();
  });

  it("offers an admin the Platform page", async () => {
    renderPalette({ role: "admin" });
    await pressShortcut();

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Platform" }));
    });
    expect(mockPush).toHaveBeenCalledWith("/v2/platform");
  });
});
