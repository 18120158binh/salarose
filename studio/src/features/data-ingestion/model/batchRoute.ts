import "server-only";
import { NextResponse } from "next/server";
import * as db from "@/lib/db";
import type { EventKind } from "shared/lib/eventCatalog";
import { type BatchResult, batchEvents, eventNames, MAX_BATCH_BYTES, MAX_BATCH_EVENTS } from "./businessEvents";
import { parseProducerConfig } from "./businessEventProducer";
import { authenticateSourceKey, failure, readCapped } from "./sourceKeyAuth";

type ProducerConfig = NonNullable<ReturnType<typeof parseProducerConfig>>;

// One batch route of the data ingestion API: what it calls itself in logs, how it validates a
// batch, and where it writes the accepted events.
export interface BatchRoute<T> {
  label: string;
  validate(events: unknown[], catalog: ReadonlyMap<string, EventKind>, appId: string): BatchResult<T>;
  publish(config: ProducerConfig, records: T[]): Promise<void>;
}

// Authenticates, limits, reads, validates, and publishes one batch. Logs name the source's app
// id, never its key (DIA-NFR-05).
export async function handleBatch<T>(req: Request, route: BatchRoute<T>) {
  const auth = await authenticateSourceKey(req, route.label);
  if (!auth.ok) return auth.response;
  const { source } = auth;

  let producerConfig: ReturnType<typeof parseProducerConfig>;
  try {
    producerConfig = parseProducerConfig(process.env);
  } catch (error) {
    console.error(`${route.label}: invalid configuration:`, error);
    return failure(503, "The service is not configured.");
  }
  if (!producerConfig) {
    console.error(`${route.label} need INGESTION_KAFKA_BROKERS.`);
    return failure(503, "The service is not configured.");
  }

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

function tooLarge() {
  return failure(413, `A batch holds at most ${MAX_BATCH_EVENTS} events and ${MAX_BATCH_BYTES} bytes.`);
}
