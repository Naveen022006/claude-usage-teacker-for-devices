import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { mergedView } from "@/lib/contract";
import { fail, ok, unauthorized } from "@/lib/http";
import { loadAccount, loadDaily, loadDevices } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAuthorized(req, true)) return unauthorized();
  try {
    const [devices, account, daily] = await Promise.all([loadDevices(), loadAccount(), loadDaily(30)]);
    const view = mergedView(devices);
    return ok({ now: Date.now(), devices: view.devices, totals: view.totals, account, daily });
  } catch (e) {
    console.error("state failed", e);
    return fail("server error", 500);
  }
}
