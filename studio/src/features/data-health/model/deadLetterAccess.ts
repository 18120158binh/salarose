import "server-only";
import type { TimeZone } from "@/shared/lib/time-range";
import { getSession } from "@/shared/auth/session";
import { toCheckedAdmin, type CheckedAdmin } from "@/shared/auth/types";
import type { DeadLetterCursor, DeadLetterPage } from "./deadLetterReader";
import { windowMs, toFilter, type DeadLetterQuery } from "./deadLetterQuery";
import { deadLetterTopic, type DeadLetterContent, type Retention } from "./deadLetters";
import { deadLetterReader } from "./deadLetterServer";

// DHL-FR-09: no browser or proxy may keep a response of the dead-letter browser.
export function noStore(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// DHL-FR-05: the dead-letter routes check the role on every request.
export async function adminForRequest(): Promise<CheckedAdmin | Response> {
  const session = await getSession();
  if (!session) return noStore({ error: "unauthorized" }, 401);
  return toCheckedAdmin(session) ?? noStore({ error: "forbidden" }, 403);
}

export interface DeadLetterAccess {
  readPage(query: DeadLetterQuery, zone: TimeZone, cursor?: DeadLetterCursor): Promise<DeadLetterPage>;
  readContent(partition: number, offset: number): Promise<DeadLetterContent | null>;
  retention(): Promise<Retention>;
}

// Every read of the dead-letter topic goes through here, and only an admin checked on this request
// gets in.
export function deadLetterAccess(admin: CheckedAdmin): DeadLetterAccess {
  const reader = deadLetterReader();
  return {
    readPage: (query, zone, cursor) => reader.readPage({ windowMs: windowMs(query.window, zone, Date.now()), filter: toFilter(query), cursor }),
    readContent(partition, offset) {
      // DHL-FR-10: who opened which record, never what it holds.
      console.info(
        `[dead-letters] Admin ${admin.userId} opened the content of topic ${deadLetterTopic(process.env)} partition ${partition} offset ${offset}.`,
      );
      return reader.readContent(partition, offset);
    },
    retention: () => reader.retention(),
  };
}
