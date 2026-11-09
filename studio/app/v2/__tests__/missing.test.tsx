import { render, screen } from "@testing-library/react";
import V2Missing from "../[...missing]/page";
import V2NotFound from "../not-found";

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

describe("a /v2 path without a page (SHL-FR-01)", () => {
  it("answers every reserved route and unknown path with the not-found page", () => {
    expect(() => V2Missing()).toThrow("NEXT_NOT_FOUND");
  });

  it("shows the same page as any unknown address, with a way home (SHL-FR-22)", () => {
    render(<V2NotFound />);

    expect(screen.getByRole("heading", { name: "We couldn't find that page." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/v2");
  });
});
