import { postRecords } from "../../../../src/features/data-import/model/importApi";

export async function POST(req: Request, ctx: { params: Promise<{ record_type: string }> }) {
  return postRecords(req, (await ctx.params).record_type);
}
