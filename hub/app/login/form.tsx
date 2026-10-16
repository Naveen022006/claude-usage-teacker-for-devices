"use client";

import { useActionState } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action}>
      <label htmlFor="password">Hub token</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
      {state?.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>{pending ? "Signing in..." : "Sign in"}</button>
    </form>
  );
}
