import "server-only";
import { NextResponse } from "next/server";
import * as db from "@/lib/db";
import type { EventKind } from "shared/lib/eventCatalog";
import { type BatchResult, batchEvents, eventNames, MAX_BATCH_BYTES, MAX_BATCH_EVENTS } from "./businessEvents";
import { parseProducerConfig } from "./businessEventProducer";
import { createKeyRateLimiter, parseRequestsPerSecond } from "./rateLimit";
import { bearerKey, hashSourceKey } from "./sourceKeys";

type ProducerConfig = NonNullable<ReturnType<typeof parseProducerConfig>>;

// One batch route of the data ingestion API: what it calls itself in logs, how it validates a
// batch, and where it writes the accepted events.
export interface BatchRoute<T> {
  label: string;
  validate(events: unknown[], catalog: ReadonlyMap<string, EventKind>, appId: string): BatchResult<T>;
  publish(config: ProducerConfig, records: T[]): Promise<void>;
}

// Per process: each replica counts on its own, and a restart clears the counts.
const rateLimiter = createKeyRateLimiter();

function failure(status: number, error: string, headers?: Record<string, string>) {
  return NextResponse.json({ error }, { status, headers });
}

// Authenticates, limits, reads, validates, and publishes one batch. Logs name the source's app
// id, never its key (DIA-NFR-05).
export async function handleBatch<T>(req: Request, route: BatchRoute<T>) {
  const key = bearerKey(req.headers.get("authorization"));
  if (!key) return failure(401, "A valid source key is required.");

  const keyHash = hashSourceKey(key);
  let source: db.StoredSourceKey | null;
  try {
    source = await db.findSourceKeyByHash(keyHash);
  } catch (error) {
    console.error(`${route.label}: the source key lookup failed:`, error);
    return failure(503, "The service is unavailable. Try again.");
  }
  if (!source || source.revoked) return failure(401, "A valid source key is required.");

  let perSecond: number;
  let producerConfig: ReturnType<typeof parseProducerConfig>;
  try {
    perSecond = parseRequestsPerSecond(process.env);
    producerConfig = parseProducerConfig(process.env);
  } catch (error) {
    console.error(`${route.label}: invalid configuration:`, error);
    return failure(503, "The service is not configured.");
  }
  if (!producerConfig) {
    console.error(`${route.label} need INGESTION_KAFKA_BROKERS.`);
    return failure(503, "The service is not configured.");
  }

  const decision = rateLimiter.take(keyHash, perSecond);
  if (!decision.allowed) {
    return failure(429, "Too many requests for this source key.", { "Retry-After": String(decision.retryAfterSeconds) });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BATCH_BYTES) return tooLarge();
  // content-length can be absent, as with a chunked body, so the cap holds while reading too.
  const text = await readCapped(req, MAX_BATCH_BYTES);
  if (text === null) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, "The body must be JSON with an events list.");
  }
  const events = batchEvents(body);
  if (!events) return failure(400, "The body must be JSON with an events list.");
  if (events.length > MAX_BATCH_EVENTS) return tooLarge();

  let result: BatchResult<T>;
  try {
    result = route.validate(events, await db.getCatalogEventKinds(eventNames(events)), source.appId);
  } catch (error) {
    console.error(`${route.label}: the catalog lookup failed:`, error);
    return failure(503, "The service is unavailable. Try again.");
  }

  if (result.accepted.length > 0) {
    try {
      await route.publish(producerConfig, result.accepted);
    } catch (error) {
      console.error(`${route.label} from ${source.appId}: the write to Kafka failed:`, error);
      return failure(503, "The events could not be stored. Resend the batch.");
    }
  }

  return NextResponse.json({ accepted: result.accepted.length, rejected: result.rejected });
}

// The body as text, or null once it passes maxBytes. Stops reading at the cap.
async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tooLarge() {
  return failure(413, `A batch holds at most ${MAX_BATCH_EVENTS} events and ${MAX_BATCH_BYTES} bytes.`);
}
