"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

export function DeleteDevice({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function onClick() {
    if (!window.confirm(`Delete device "${name}" and its history? It will reappear if it reports again.`)) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setErr("Delete failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span>
      <button className="danger" onClick={onClick} disabled={busy} aria-label={`Delete device ${name}`}>
        {busy ? "Deleting..." : "Delete"}
      </button>
      {err ? <span className="err" role="alert"> {err}</span> : null}
    </span>
  );
}
