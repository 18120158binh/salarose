import React from "react";
import { render, screen } from "@testing-library/react";
import Header from "../Header";

function markupWithoutV2Link(container: HTMLElement): string {
  screen.queryByRole("link", { name: "Try the new studio" })?.remove();
  return container.innerHTML;
}

describe("Header outside the v2 link", () => {
  it.each([
    ["campaign", false],
    ["campaign", true],
    ["segments", false],
    ["segments", true],
  ] as const)("renders the %s view (admin: %p) as before v2", (currentView, isAdminUser) => {
    const { container } = render(<Header currentView={currentView} isAdminUser={isAdminUser} />);

    expect(markupWithoutV2Link(container)).toMatchSnapshot();
  });
});
