import { readFileSync } from "node:fs";
import { join } from "node:path";

// The classic theme cookie puts .dark on <html>, and a soft navigation from classic to /v2 keeps it.
// v2 is light only (SHL-FR-14), so nothing dark may apply while the document holds a v2 shell.
// jsdom's selector engine cannot evaluate :has inside :not, so this checks the selectors instead.
const css = readFileSync(join(__dirname, "../globals.css"), "utf8");
const V2_EXCLUDED = ".dark:not(:has([data-salarose]))";

describe("globals.css under a v2 page", () => {
  it("scopes the dark variant away from v2, so dark: utilities in coss and the kit cannot apply", () => {
    expect(css).toContain(`@custom-variant dark (&:is(${V2_EXCLUDED} *));`);
  });

  it("scopes every dark token block away from v2, so v2 keeps only the light Salarose tokens", () => {
    const darkBlocks = [...css.matchAll(/^([^\n{}@]*\.dark[^\n{}]*)\{/gm)].map((match) => match[1].trim());

    expect(darkBlocks).not.toHaveLength(0);
    for (const selector of darkBlocks) expect(selector).toBe(V2_EXCLUDED);
  });
});
