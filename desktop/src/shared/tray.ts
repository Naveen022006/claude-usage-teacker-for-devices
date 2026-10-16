// Contract between the Node usage server (desktop/src/server) and the Windows tray app
// (desktop/tray/UsageMeterTray.ps1). The tray polls GET /u/<key>/api/tray every 5 s and renders this
// as-is, so all formatting decisions live here on the Node side (PowerShell only computes countdowns).
//
// Discovery: the server writes %APPDATA%/UsageMeterDesktop/instance.json = { port, key, pid }.
// Lifetime: the tray starts `node desktop/dist/server.cjs --headless --parent-pid <trayPid>`; the server
// exits when that PID is gone, or on POST /u/<key>/api/request {type:"quit"}.

export type Tone = "ok" | "warn" | "bad"; // blue < 80, amber >= 80, red >= 95

export interface TrayLimit {
  label: string; // "Session (5h)", "Weekly", "Weekly Opus", "Weekly Sonnet"
  pct: number | null; // 0–100, null = unknown ("—")
  resetsAt: string | null; // ISO; tray renders a live countdown with seconds
  tone: Tone;
}

export interface TrayModel {
  label: string; // prettyModel(): "Opus 5.5"
  pct5h: number | null; // percentage points of the 5h session attributed to this model
  pctWeek: number | null; // percentage points of the weekly limit
  tokens: number; // NEW tokens in the last 5 h: input + cache_creation + output (cache READS excluded)
  tokensText: string; // "48k", "1.2M"
}

export interface TrayState {
  ok: boolean;
  updatedAt: number; // epoch ms
  plan: "free" | "pro" | "max" | "team" | null;
  /** Where Session/Weekly came from: Claude account (OAuth usage API), the Usage Hub, or nothing. */
  limitsSource: "account" | "hub" | null;
  /** Short human message when limits are unavailable, e.g. "Open Claude Code once to refresh sign-in". */
  limitsNote: string | null;
  /** Which Claude sign-in feeds Session/Weekly: the tray-owned Claude Desktop-account login, the Claude Code CLI login, or none. */
  accountKind?: "tray" | "cli" | null;
  limits: TrayLimit[]; // always includes Session (5h) and Weekly (pct null when unknown)
  models: TrayModel[]; // sorted by pct5h desc, then tokens desc; max 6
  /** true when per-model points include a baseline split estimated from local events (tray shows "≈"). */
  modelsEstimated?: boolean;
  other: { pct5h: number | null; pctWeek: number | null } | null;
  /** Tray tooltip (≤ 127 chars, NotifyIcon limit): "Claude · Session 42% (3h 5m) · Weekly 11%". */
  tooltip: string;
  /** Number drawn on the tray icon: rounded Session %, or null → draw a neutral icon. */
  iconPct: number | null;
  iconTone: Tone;
}
