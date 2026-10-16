import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/auth";

// Redirect unauthenticated page requests to /login. API routes do their own auth.
export function proxy(req: NextRequest) {
  if (verifySession(req.cookies.get(COOKIE_NAME)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!api|login|_next|favicon\\.ico|icon\\.svg).*)"],
};
