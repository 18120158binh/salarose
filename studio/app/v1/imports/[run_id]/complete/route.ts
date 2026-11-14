import { completeImport } from "../../../../../src/features/data-import/model/importApi";

export async function POST(req: Request, ctx: { params: Promise<{ run_id: string }> }) {
  return completeImport(req, (await ctx.params).run_id);
}
