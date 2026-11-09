import type { NextRequest } from "next/server";
import { adminForRequest, deadLetterAccess, noStore } from "@/features/data-health/model/deadLetterAccess";
import { parseCursor, parseDeadLetterQuery } from "@/features/data-health/model/deadLetterQuery";
import { DeadLetterReadError } from "@/features/data-health/model/deadLetterReader";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";

// One page of the dead-letter browser: rows without content, newest first (DHL-FR-06). The window
// is counted in the zone of the tz cookie, as the page names it.
export async function GET(request: NextRequest): Promise<Response> {
  const admin = await adminForRequest();
  if (admin instanceof Response) return admin;

  const params = request.nextUrl.searchParams;
  const query = parseDeadLetterQuery((name) => params.get(name) ?? undefined);
  const older = params.get("older");
  const cursor = older === null ? undefined : parseCursor(older);
  if (!query || (older !== null && !cursor)) return noStore({ error: "bad request" }, 400);

  try {
    return noStore(await deadLetterAccess(admin).readPage(query, parseTimeZone(request.cookies.get(TZ_COOKIE)?.value), cursor));
  } catch (error) {
    if (error instanceof DeadLetterReadError) return noStore({ error: error.reason }, 503);
    throw error;
  }
}
