import "server-only";
import { readOnly } from "@/lib/db";
import type { CheckedAdmin } from "@/shared/auth/types";
import {
  accessLogQuery,
  LOG_COUNTS_QUERY,
  parseLogCounts,
  parseLogRow,
  parseRequest,
  REQUESTS_QUERY,
  type AccessLogRow,
  type DeletionRequestRow,
  type LogFilter,
} from "./privacyLog";

const READ_TIMEOUT_MS = 5_000;

export interface PrivacyPage {
  requests: DeletionRequestRow[];
  log: AccessLogRow[];
  counts: Record<LogFilter, number>;
}

/** DIM-FR-22, DIM-FR-23: only an admin reads the requests and the log, so the loader takes a CheckedAdmin. */
export async function loadPrivacyPage(_admin: CheckedAdmin, filter: LogFilter): Promise<PrivacyPage> {
  return readOnly(READ_TIMEOUT_MS, async (run) => ({
    requests: (await run(REQUESTS_QUERY)).flatMap((row) => parseRequest(row) ?? []),
    log: (await run(accessLogQuery(filter))).flatMap((row) => parseLogRow(row) ?? []),
    counts: parseLogCounts(await run(LOG_COUNTS_QUERY)),
  }));
}
