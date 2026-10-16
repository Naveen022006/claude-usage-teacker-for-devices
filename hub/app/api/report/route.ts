import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { MAX_BODY, validateReport } from "@/lib/contract";
import { fail, ok, unauthorized } from "@/lib/http";
import { saveReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return unauthorized();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return fail("payload too large", 413);
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) return fail("payload too large", 413);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("invalid json", 400);
  }
  const report = validateReport(json);
  if (!report) return fail("invalid report", 400);
  try {
    await saveReport(report);
  } catch (e) {
    console.error("saveReport failed", e);
    return fail("server error", 500);
  }
  return ok();
}
