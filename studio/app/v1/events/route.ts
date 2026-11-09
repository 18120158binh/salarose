import { handleBatch } from "../../../src/features/data-ingestion/model/batchRoute";
import { publishPersonEvents } from "../../../src/features/data-ingestion/model/businessEventProducer";
import { validatePersonEvents } from "../../../src/features/data-ingestion/model/personEvents";

// Person events, which event ingestion parses and stitches like tracker hits (DIA-FR-07).
export function POST(req: Request) {
  return handleBatch(req, { label: "Person events", validate: validatePersonEvents, publish: publishPersonEvents });
}
