import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { COLUMN_TYPES, DATASET_KINDS, DELIMITERS, DELIVERY_MODES } from "../domain";

// The golden fixtures of the import applier (test-fixtures/data-import). The applier's Maven tests run each one, and
// the studio dry run must give the same rejects, file-level failures, and threshold for them (DIM-FR-16). Until the
// dry run exists, this test keeps the fixtures readable by studio and their versions in studio's domain.
const FIXTURES = path.join(__dirname, "..", "..", "..", "..", "..", "..", "test-fixtures", "data-import");

interface Spec {
  kind: string;
  columns: { name: string; type: string; aliases: string[] }[];
  roles: Record<string, string | string[]>;
  deliveryMode: string;
  delimiter: string;
  format: string;
}

interface Expected {
  fileFailures: string[];
  conditions: string[];
  counts?: { rows_read: number; valid: number; rejected: number; rejected_by_reason: Record<string, number> };
  rejects?: { line: number; reason: string }[];
}

const cases = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function read<T>(name: string, file: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name, file), "utf8")) as T;
}

describe("import applier golden fixtures", () => {
  it("are present", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases)("%s has a version in studio's domain, an input, and a consistent report", (name) => {
    const spec = read<Spec>(name, "case.json");
    const expected = read<Expected>(name, "expected.json");
    expect(DATASET_KINDS).toContain(spec.kind);
    expect(DELIVERY_MODES).toContain(spec.deliveryMode);
    expect(DELIMITERS).toContain(spec.delimiter);
    for (const column of spec.columns) expect(COLUMN_TYPES).toContain(column.type);
    const names = new Set(spec.columns.map((column) => column.name));
    for (const mapped of Object.values(spec.roles).flat()) expect(names).toContain(mapped);
    expect(existsSync(path.join(FIXTURES, name, `input.${spec.format}`))).toBe(true);

    if (expected.fileFailures.length > 0) {
      expect(expected.counts).toBeUndefined();
      return;
    }
    const counts = expected.counts!;
    const rejects = expected.rejects ?? [];
    expect(counts.rejected).toBe(rejects.length);
    expect(counts.valid).toBe(counts.rows_read - counts.rejected);
    const byReason: Record<string, number> = {};
    for (const reject of rejects) byReason[reject.reason] = (byReason[reject.reason] ?? 0) + 1;
    expect(counts.rejected_by_reason).toEqual(byReason);
    expect(expected.conditions.includes("reject_threshold")).toBe(counts.rejected > 0.05 * counts.rows_read);
  });
});
