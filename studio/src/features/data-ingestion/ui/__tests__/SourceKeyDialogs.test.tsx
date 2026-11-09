import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createSourceKeyAction, revokeSourceKeyAction } from "../../model/actions";
import { CreateSourceKeyDialog } from "../CreateSourceKeyDialog";
import { RevokeSourceKeyButton } from "../RevokeSourceKeyButton";

jest.mock("../../model/actions", () => ({ createSourceKeyAction: jest.fn(), revokeSourceKeyAction: jest.fn() }));
jest.mock("@/shared/ui/v2/toast", () => ({ notify: jest.fn() }));

const KEY = "cdp_sk_secretsecretsecretsecretsecretsecret12";

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => jest.clearAllMocks());

async function openCreate() {
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  return screen.findByRole("dialog", { name: "Create a source key" });
}

function create(dialog: HTMLElement, appId: string) {
  fireEvent.change(within(dialog).getByLabelText("Source name (app id)"), { target: { value: appId } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
}

describe("Create key (DHL-FR-04, DIA-FR-16)", () => {
  it("shows the key once with Copy, and holds no copy after the dialog closes", async () => {
    jest.mocked(createSourceKeyAction).mockResolvedValue({ appId: "inventory-service", key: KEY });
    render(<CreateSourceKeyDialog />);

    create(await openCreate(), "inventory-service");

    const result = await screen.findByRole("dialog", { name: "Key for inventory-service" });
    expect(within(result).getByText(KEY)).toBeInTheDocument();
    expect(within(result).getByText(/You will not see this key again/)).toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Copy" })).toBeInTheDocument();

    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(KEY);

    const reopened = await openCreate();
    expect(within(reopened).getByLabelText("Source name (app id)")).toHaveValue("");
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("keeps the app id and shows the error when the create fails", async () => {
    jest.mocked(createSourceKeyAction).mockResolvedValue({ error: 'The app id "inventory-service" already has a key. Revoke it first.' });
    render(<CreateSourceKeyDialog />);

    const dialog = await openCreate();
    create(dialog, "inventory-service");

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already has a key");
    expect(within(dialog).getByLabelText("Source name (app id)")).toHaveValue("inventory-service");
  });
});

describe("Revoke (DHL-FR-04, DIA-FR-17)", () => {
  async function openRevoke() {
    render(<RevokeSourceKeyButton appId="inventory-service" id="sk_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke the key for inventory-service" }));
    return screen.findByRole("alertdialog", { name: "Revoke the key for inventory-service?" });
  }

  it("names the app id and says requests will be refused, and Cancel revokes nothing", async () => {
    const dialog = await openRevoke();

    expect(dialog).toHaveTextContent("Requests with this key will be refused, from the next request on.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(revokeSourceKeyAction).not.toHaveBeenCalled();
  });

  it("revokes the key by its id once confirmed", async () => {
    jest.mocked(revokeSourceKeyAction).mockResolvedValue({ done: true });
    const dialog = await openRevoke();

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => expect(revokeSourceKeyAction).toHaveBeenCalledWith("sk_1"));
  });
});
