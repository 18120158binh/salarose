import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { SystemRole } from "@/shared/auth/types";
import { parseTimeZone, UTC, type TimeZone } from "@/shared/lib/time-range";
import { withStage } from "../../model/__fixtures__/stage";
import { ClassicPage } from "../ClassicPage";
import { V2Shell } from "../V2Shell";

let mockPathname = "/v2";
const mockRefresh = jest.fn();
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname, useRouter: () => ({ refresh: mockRefresh }) }));

const cookieWrites: { name: string; value: string }[] = [];

beforeAll(() => {
  // The shared sidebar remembers its state through the Cookie Store API, which jsdom lacks.
  Object.defineProperty(globalThis, "cookieStore", {
    configurable: true,
    value: { set: async (cookie: { name: string; value: string }) => void cookieWrites.push(cookie) },
  });
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  mockPathname = "/v2";
  mockRefresh.mockClear();
  cookieWrites.length = 0;
  setWindowWidth(1280);
  document.documentElement.className = "";
  document.cookie = "theme=; max-age=0; path=/";
});

// matchMedia for a window of the given width, for the min-width and max-width queries the shell uses.
function setWindowWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}

const noNames = async () => ({ status: "found", journeys: [], segments: [] }) as const;

// The zone the test runner's browser reports. jest.config sets TZ to a zone that is not UTC.
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function shell({
  role = "editor",
  preview = role === "admin",
  sidebarOpen = true,
  zone = parseTimeZone(BROWSER_ZONE),
  page = <p>Page content</p>,
}: { role?: SystemRole; preview?: boolean; sidebarOpen?: boolean; zone?: TimeZone; page?: ReactNode } = {}) {
  return (
    <V2Shell
      email={`${role}@example.com`}
      searchNames={noNames}
      sidebarOpen={sidebarOpen}
      viewer={{ role, preview }}
      workspace="Acme Retail"
      zone={zone}
    >
      {page}
    </V2Shell>
  );
}

function renderShell(options: Parameters<typeof shell>[0] = {}) {
  return render(shell(options));
}

// The top bar's menu button. The sidebar's edge rail shares its name but takes no focus.
const menuButton = () => document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;

const sidebarState = (container: HTMLElement) =>
  container.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state");

describe("V2Shell sidebar", () => {
  it("offers an editor no Sources, Dropped data, or Platform entry (SHL-FR-04)", () => {
    renderShell({ role: "editor" });

    const nav = screen.getByRole("navigation", { name: "Studio" });
    expect(within(nav).getByText("Home")).toBeInTheDocument();
    expect(within(nav).getByText("Events")).toBeInTheDocument();
    expect(within(nav).queryByText("Sources")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Dropped data")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Platform")).not.toBeInTheDocument();
  });

  it("offers an editor with preview access no admin page, Settings included (SHL-FR-22)", () => {
    renderShell({ role: "editor", preview: true });

    const nav = screen.getByRole("navigation", { name: "Studio" });
    expect(within(nav).queryByText("Settings")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Platform")).not.toBeInTheDocument();
  });

  it("offers an admin Sources, Dropped data, Platform, and Settings with its Preview badge (SHL-FR-04, SHL-FR-22)", () => {
    renderShell({ role: "admin" });

    const nav = screen.getByRole("navigation", { name: "Studio" });
    expect(within(nav).getByText("Sources")).toBeInTheDocument();
    expect(within(nav).getByText("Dropped data")).toBeInTheDocument();
    const settings = within(nav).getByRole("link", { name: /^Settings/ });
    expect(settings).toHaveAttribute("href", "/v2/settings");
    expect(within(settings.closest("li")!).getByText("Preview")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/v2/platform");
  });

  it("highlights the current page (SHL-FR-05)", () => {
    mockPathname = "/v2/platform";
    renderShell({ role: "admin" });

    expect(screen.getByRole("link", { name: "Platform" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("gives a reserved route no entry (SHL-FR-01)", async () => {
    await withStage(["dead-letters"], "reserved", () => {
      renderShell({ role: "admin" });

      expect(screen.queryByText("Dropped data")).not.toBeInTheDocument();
    });
  });

  it("hides a preview page from an editor without preview access (SHL-FR-22)", async () => {
    await withStage(["customers"], "preview", () => {
      renderShell({ role: "editor", preview: false });

      expect(screen.queryByText("Customers")).not.toBeInTheDocument();
    });
  });

  it("stays collapsed after a reload when the viewer collapsed it (SHL-FR-05)", () => {
    const { container } = renderShell({ sidebarOpen: false });

    expect(sidebarState(container)).toBe("collapsed");
  });

  it("remembers a collapse in the browser (SHL-FR-05)", async () => {
    const { container } = renderShell();

    await act(async () => fireEvent.click(menuButton()));

    expect(sidebarState(container)).toBe("collapsed");
    expect(cookieWrites).toContainEqual(expect.objectContaining({ name: "sidebar_state", value: "false" }));
  });

  it.each([
    [1280, "expanded"],
    [900, "collapsed"],
  ])("at %p px starts %p (SHL-NFR-04)", (width, state) => {
    setWindowWidth(width);
    const { container } = renderShell();

    expect(sidebarState(container)).toBe(state);
  });

  it("at 700 px hides the sidebar and opens it as a sheet from the menu button (SHL-FR-05)", async () => {
    setWindowWidth(700);
    renderShell();

    expect(screen.queryByRole("navigation", { name: "Studio" })).not.toBeInTheDocument();

    await act(async () => fireEvent.click(menuButton()));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("navigation", { name: "Studio" })).toBeInTheDocument();
  });
});

describe("V2Shell keyboard", () => {
  it("makes Skip to content the first stop and points it at the page content (SHL-NFR-02)", () => {
    renderShell();

    const skip = screen.getByRole("link", { name: "Skip to content" });
    const firstStop = document.querySelector('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])');
    expect(firstStop).toBe(skip);
    const target = document.getElementById(skip.getAttribute("href")!.slice(1));
    expect(target).toContainElement(screen.getByText("Page content"));
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});

describe("V2Shell top bar", () => {
  it("shows the workspace name, the command palette button with its shortcut, and the account menu, with no theme switch (SHL-FR-06)", () => {
    renderShell();

    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search or jump to…" })).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("lists the viewer's email, role, Back to classic, and Sign out in the account menu (SHL-FR-06, SHL-FR-08)", async () => {
    mockPathname = "/v2/platform";
    renderShell({ role: "admin" });

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByText("admin@example.com")).toBeInTheDocument();
    expect(within(menu).getByText("Admin")).toBeInTheDocument();
    expect(within(menu).getByText("Preview access: on")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Account/ })).toHaveAttribute("href", "/v2/account");
    expect(within(menu).getByRole("menuitem", { name: "Back to classic" })).toHaveAttribute("href", "/platform");
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("opens the classic page a v2 page names, such as a journey's classic builder for its owner, and the route table's page once it is gone (SHL-FR-08)", async () => {
    mockPathname = "/v2/journeys/CAMP-4f1c9a0b2d3e5f67";
    const { rerender } = renderShell({ page: <ClassicPage href="/campaign/CAMP-4f1c9a0b2d3e5f67" /> });

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByRole("menuitem", { name: "Back to classic" })).toHaveAttribute("href", "/campaign/CAMP-4f1c9a0b2d3e5f67");

    rerender(shell());
    expect(screen.getByRole("menuitem", { name: "Back to classic" })).toHaveAttribute("href", "/campaign");
  });

  it("offers no Account item to an editor without preview access while Account is at preview (SHL-FR-22)", async () => {
    renderShell({ role: "editor", preview: false });

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByText("Preview access: off")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /^Account/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("names the brand Salarose and the current page in the top bar", () => {
    mockPathname = "/v2/data/events";
    renderShell();

    expect(screen.getByText("Salarose")).toBeInTheDocument();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail).toHaveTextContent("Acme Retail/Data/Events");
  });

  it("signs out by posting to the sign-out route", async () => {
    renderShell();
    const form = document.querySelector<HTMLFormElement>('form[action="/api/auth/logout"]');
    expect(form).toHaveAttribute("method", "post");
    const submit = jest.fn();
    form!.requestSubmit = submit;

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("leaves the classic theme cookie as it is (SHL-FR-14)", () => {
    document.cookie = "theme=dark; path=/";

    renderShell();

    expect(document.cookie).toContain("theme=dark");
  });
});

describe("V2Shell time zone", () => {
  it("writes the browser's zone to the tz cookie on every page load (SHL-FR-15)", () => {
    renderShell();

    expect(document.cookie).toContain(`tz=${BROWSER_ZONE}`);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("refreshes the data once when the server rendered in UTC, and no more if the zone still differs (SHL-FR-15)", () => {
    expect(BROWSER_ZONE).not.toBe("UTC");
    const { rerender } = renderShell({ zone: UTC });

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    rerender(shell({ zone: UTC, sidebarOpen: false }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
