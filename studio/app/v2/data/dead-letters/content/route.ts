import type { NextRequest } from "next/server";
import { adminForRequest, deadLetterAccess, noStore } from "@/features/data-health/model/deadLetterAccess";
import { parsePosition } from "@/features/data-health/model/deadLetterQuery";
import { DeadLetterReadError } from "@/features/data-health/model/deadLetterReader";

// One record's content, fetched only when an admin opens it (DHL-FR-07).
export async function GET(request: NextRequest): Promise<Response> {
  const admin = await adminForRequest();
  if (admin instanceof Response) return admin;

  const params = request.nextUrl.searchParams;
  const position = parsePosition(params.get("partition"), params.get("offset"));
  if (!position) return noStore({ error: "bad request" }, 400);

  try {
    const content = await deadLetterAccess(admin).readContent(position.partition, position.offset);
    return content === null ? noStore({ error: "gone" }, 404) : noStore({ content });
  } catch (error) {
    if (error instanceof DeadLetterReadError) return noStore({ error: error.reason }, 503);
    throw error;
  }
}
