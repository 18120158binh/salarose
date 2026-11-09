/** @jest-environment node */

// getCampaignNodeStats in shared/lib/db.ts reads campaign_node_stats through a pg Pool. These
// tests replace the pool with a fake that records each statement, and check the statement
// against the view that infra/db/schema.sql defines.
import { readFileSync } from "node:fs";
import path from "node:path";

interface MockStatement {
  text: string;
  values: unknown[];
}

const mockStatements: MockStatement[] = [];
let mockRows: Record<string, unknown>[] = [];

jest.mock("../../shared/node_modules/pg", () => {
  const query = async (text: string, values: unknown[] = []) => {
    mockStatements.push({ text: text.replace(/\s+/g, " ").trim(), values });
    return { rows: mockRows, rowCount: mockRows.length };
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query,
      connect: async () => ({ query, release: () => undefined }),
    })),
  };
});

import { ensureDbInitialized, getCampaignNodeStats } from "@/lib/db";

const lan = { userId: "user_lan", isAdmin: false };

const SCHEMA_SQL = path.join(__dirname, "..", "..", "infra", "db", "schema.sql");

function statsViewColumns(): string[] {
  const view = /CREATE OR REPLACE VIEW campaign_node_stats \(([^)]*)\) AS/.exec(readFileSync(SCHEMA_SQL, "utf8"));
  if (!view) throw new Error("schema.sql has no view campaign_node_stats");
  return view[1].split(",").map((column) => column.trim());
}

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://test";
  await ensureDbInitialized();
});

beforeEach(() => {
  mockStatements.length = 0;
  mockRows = [];
});

describe("getCampaignNodeStats", () => {
  it("reads only columns that the campaign_node_stats view defines", async () => {
    await getCampaignNodeStats("cmp_1", lan);

    expect(mockStatements).toHaveLength(1);
    const read = /^SELECT (.+) FROM campaign_node_stats s JOIN campaigns c ON c\.id = s\.(\w+) WHERE s\.(\w+) = \$1 AND /.exec(
      mockStatements[0].text,
    );
    expect(read).not.toBeNull();
    const [, selected, joined, filter] = read!;
    const columns = [...selected.split(",").map((column) => column.trim().replace(/^s\./, "")), joined, filter];

    expect(statsViewColumns()).toEqual(expect.arrayContaining(columns));
    expect(mockStatements[0].values).toEqual(["cmp_1", lan.userId, false]);
  });

  it("maps each node to its count, which pg returns as a string for bigint", async () => {
    mockRows = [
      { node_id: "check_1", user_count: "12" },
      { node_id: "check_1-no-end", user_count: "5" },
    ];

    await expect(getCampaignNodeStats("cmp_1", lan)).resolves.toEqual({ check_1: 12, "check_1-no-end": 5 });
  });
});
