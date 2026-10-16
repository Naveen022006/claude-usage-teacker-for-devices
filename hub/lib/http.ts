import { NextResponse } from "next/server";

const headers = { "Cache-Control": "no-store" };

export const ok = (extra: Record<string, unknown> = {}, status = 200) =>
  NextResponse.json({ ok: true, ...extra }, { status, headers });

export const fail = (error: string, status: number) =>
  NextResponse.json({ ok: false, error }, { status, headers });

export const unauthorized = () => fail("unauthorized", 401);
