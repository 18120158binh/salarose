"use server";

import { readOnly } from "@/lib/db";
import { assertSession } from "@/shared/auth/session";
import { journeyNameQuery, parseNameMatches, segmentNameQuery, type NameSearch } from "@/widgets/v2-shell/model/palette";

const SEARCH_STATEMENT_TIMEOUT_MS = 2000;
const MAX_TEXT_LENGTH = 200;

/**
 * SHL-FR-07: journeys and segments whose name holds the typed text. A failure, an expired
 * session included, returns `failed`, so the palette still offers the pages. It only reads.
 */
export async function searchPaletteNames(text: unknown): Promise<NameSearch> {
  const query = typeof text === "string" ? text.trim().slice(0, MAX_TEXT_LENGTH) : "";
  if (query === "") return { status: "found", journeys: [], segments: [] };
  try {
    await assertSession();
    return await readOnly(SEARCH_STATEMENT_TIMEOUT_MS, async (run) => {
      const journeys = parseNameMatches(await run(journeyNameQuery(query)));
      const segments = parseNameMatches(await run(segmentNameQuery(query)));
      return { status: "found", journeys, segments };
    });
  } catch (error) {
    console.error("Command palette search failed:", error);
    return { status: "failed" };
  }
}
