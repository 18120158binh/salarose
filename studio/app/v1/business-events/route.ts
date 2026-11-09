import { handleBatch } from "../../../src/features/data-ingestion/model/batchRoute";
import { publishBusinessEvents } from "../../../src/features/data-ingestion/model/businessEventProducer";
import { validateBusinessEvents } from "../../../src/features/data-ingestion/model/businessEvents";

export function POST(req: Request) {
  return handleBatch(req, { label: "Business events", validate: validateBusinessEvents, publish: publishBusinessEvents });
}
