import { createImport } from "../../../src/features/data-import/model/importApi";

export function POST(req: Request) {
  return createImport(req);
}
