import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { ok, unauthorized } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  if (!isAuthorized(req)) return unauthorized();
  return ok({ name: "Claude Usage Hub", v: 1 });
}
