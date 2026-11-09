import "server-only";
import type { Reading } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DeadLetterReadError } from "./deadLetterReader";
import { windowMs, type DeadLetterWindow } from "./deadLetterQuery";
import { deadLetterReader } from "./deadLetterServer";

// How many records ingestion dropped in the window. The count reads only the topic's offsets,
// never a record, so every staff user may see it, as on Home (HOM-FR-08).
export async function droppedInWindow(window: DeadLetterWindow, zone: TimeZone, now: number): Promise<Reading<number>> {
  return droppedInLast(windowMs(window, zone, now));
}

// DHL-FR-01: the Events page counts the last 24 hours, not a calendar window.
export async function droppedInLast(ms: number): Promise<Reading<number>> {
  try {
    return { available: true, value: await deadLetterReader().droppedCount(ms) };
  } catch (error) {
    const reason = error instanceof DeadLetterReadError ? error.reason : "read failed";
    if (!(error instanceof DeadLetterReadError)) {
      console.warn(`[monitoring] Dropped records could not be counted (${error instanceof Error ? error.name : "unknown error"}).`);
    }
    return { available: false, reason: `Dropped records could not be counted: ${reason}.` };
  }
}
