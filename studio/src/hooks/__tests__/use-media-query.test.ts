import { mediaQueryFor } from "../use-media-query";

describe("mediaQueryFor", () => {
  it.each([
    ["md", "(min-width: 768px)"],
    ["max-md", "(max-width: 767px)"],
    ["max-lg", "(max-width: 1023px)"],
    ["(prefers-reduced-motion: reduce)", "(prefers-reduced-motion: reduce)"],
  ])("reads %p as %p", (query, media) => {
    expect(mediaQueryFor(query)).toBe(media);
  });
});
