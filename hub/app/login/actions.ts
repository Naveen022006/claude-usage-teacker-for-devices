"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, SESSION_MS, checkToken, signSession } from "@/lib/auth";

export async function login(_prev: { error?: string } | undefined, form: FormData) {
  const pw = form.get("password");
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { error: "Server is missing SESSION_SECRET." };
  if (typeof pw !== "string" || !checkToken(pw)) return { error: "Wrong token." };
  const { value } = signSession(secret);
  (await cookies()).set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(COOKIE_NAME);
  redirect("/login");
}
