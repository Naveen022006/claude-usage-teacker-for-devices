import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { fail, ok, unauthorized } from "@/lib/http";
import { deleteDevice } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await ctx.params;
  if (!id || id.length > 128) return fail("invalid id", 400);
  try {
    const removed = await deleteDevice(id);
    return removed ? ok() : fail("not found", 404);
  } catch (e) {
    console.error("delete failed", e);
    return fail("server error", 500);
  }
}
