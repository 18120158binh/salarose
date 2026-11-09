import React from "react";
import { render, screen } from "@testing-library/react";
import Header from "../Header";

describe("Header", () => {
  it("offers Platform to an admin", () => {
    render(<Header currentView="campaign" isAdminUser />);

    expect(screen.getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/platform");
  });

  it("hides Platform from an editor", () => {
    render(<Header currentView="campaign" />);

    expect(screen.queryByRole("link", { name: "Platform" })).not.toBeInTheDocument();
  });

  it.each([true, false])("links to the new studio (admin: %p)", (isAdminUser) => {
    render(<Header currentView="segments" isAdminUser={isAdminUser} />);

    expect(screen.getByRole("link", { name: "Try the new studio" })).toHaveAttribute("href", "/v2");
  });
});
