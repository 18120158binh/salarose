import { getImport } from "../../../../src/features/data-import/model/importApi";

export async function GET(req: Request, ctx: { params: Promise<{ run_id: string }> }) {
  return getImport(req, (await ctx.params).run_id);
}
