import React from "react";
import { render, screen } from "@testing-library/react";
import AdminHeader from "../AdminHeader";

describe("AdminHeader", () => {
  it("renders as before v2 outside the v2 link", () => {
    const { container } = render(<AdminHeader />);
    screen.queryByRole("link", { name: "Try the new studio" })?.remove();

    expect(container.innerHTML).toMatchSnapshot();
  });

  it("links to the new studio", () => {
    render(<AdminHeader />);

    expect(screen.getByRole("link", { name: "Try the new studio" })).toHaveAttribute("href", "/v2");
  });
});
