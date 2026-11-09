import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";

const display = Space_Grotesk({ subsets: ["latin", "vietnamese"], weight: ["500", "600", "700"], display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "600"], display: "swap" });

// The root layout owns <html>, and menus and dialogs render outside the shell, so the fonts are set
// on the document while the Salarose scope is on the page, like the color tokens in globals.css.
export function SalaroseFonts() {
  const css = `:root:has([data-salarose]){--font-sans:${sans.style.fontFamily};--font-heading:${display.style.fontFamily};}`;
  return <style>{css}</style>;
}
