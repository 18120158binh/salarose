/** @jest-environment node */

// readOnly in shared/lib/db.ts runs v2's reads in one read-only transaction with a statement
// timeout (decision 0035, SHL-FR-11). These tests replace the pg Pool with a fake that records each
// statement on the connection readOnly takes.
const mockStatements: { text: string; values?: unknown[] }[] = [];
const mockRollback: { fails: boolean } = { fails: false };

jest.mock("../../shared/node_modules/pg", () => {
  const client = {
    query: async (text: string, values?: unknown[]) => {
      mockStatements.push(values === undefined ? { text } : { text, values });
      if (text === "ROLLBACK" && mockRollback.fails) throw new Error("Connection terminated unexpectedly");
      return { rows: text.startsWith("SELECT 1") ? [{ answer: 1 }] : [], rowCount: 0 };
    },
    // pg destroys a connection released with an error instead of returning it to the pool.
    release: (error?: Error) => {
      mockStatements.push({ text: error ? `destroy: ${error.message}` : "release" });
    },
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    })),
  };
});

import { readOnly } from "@/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  mockStatements.length = 0;
  mockRollback.fails = false;
});

describe("readOnly", () => {
  it("sets the statement timeout and turns JIT off inside a read-only transaction before the work runs", async () => {
    const rows = await readOnly(5000, (run) => run({ text: "SELECT 1 AS answer", values: [] }));

    expect(rows).toEqual([{ answer: 1 }]);
    expect(mockStatements).toEqual([
      { text: "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ" },
      { text: "SELECT set_config('statement_timeout', $1, true), set_config('jit', 'off', true)", values: ["5000"] },
      { text: "SELECT 1 AS answer", values: [] },
      { text: "COMMIT" },
      { text: "release" },
    ]);
  });

  it("rolls back, releases the connection, and rethrows when the work fails", async () => {
    const timeout = new Error("canceling statement due to statement timeout");

    await expect(
      readOnly(5000, async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
    expect(mockStatements.slice(-2)).toEqual([{ text: "ROLLBACK" }, { text: "release" }]);
    expect(mockStatements.some((statement) => statement.text === "COMMIT")).toBe(false);
  });

  it("rethrows the work's error and destroys the connection when ROLLBACK fails too", async () => {
    mockRollback.fails = true;
    const timeout = new Error("canceling statement due to statement timeout");

    await expect(
      readOnly(5000, async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
    expect(mockStatements.slice(-2)).toEqual([{ text: "ROLLBACK" }, { text: "destroy: Connection terminated unexpectedly" }]);
  });
});
