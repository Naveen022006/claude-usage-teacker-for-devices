import Link from "next/link";
import { AutoRefresh, DeleteDevice } from "@/components/client";
import { DailyChart, ModelBars } from "@/components/charts";
import { logout } from "./login/actions";
import { dayInTz, mergedView, type WindowName } from "@/lib/contract";
import { ago, fmtTokens, humanizeWindow, resetsIn, shortModel } from "@/lib/format";
import { hubTz, loadAccount, loadDaily, loadDevices } from "@/lib/store";

export const dynamic = "force-dynamic";

const TABS: { key: WindowName; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "last5h", label: "Last 5h" },
  { key: "last7d", label: "Last 7d" },
];
const SOURCE_LABEL: Record<string, string> = { chrome: "Chrome", "claude-code": "Claude Code", desktop: "Desktop" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ w?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.w) ? sp.w[0] : sp.w;
  const win: WindowName = TABS.some((t) => t.key === raw) ? (raw as WindowName) : "today";

  const [devs, account, daily] = await Promise.all([loadDevices(), loadAccount(), loadDaily(30)]);
  const now = Date.now();
  const { devices, totals } = mergedView(devs, now);
  const total = totals[win];
  const fresh = devices.filter((d) => d.fresh);
  const estimated = fresh.some((d) => d.estimated);
  const approx = estimated ? "≈" : "";

  // Columns: every model seen in this window on any device (fixed alphabetical order => stable colors).
  const modelSet = new Set<string>();
  for (const d of devices) for (const m of Object.keys(d.windows[win].byModel)) modelSet.add(m);
  const models = [...modelSet].sort();

  return (
    <main className="wrap">
      <AutoRefresh seconds={30} />
      <header className="top">
        <h1>Claude Usage Hub</h1>
        <form action={logout}><button type="submit">Log out</button></form>
      </header>

      <section className="card" aria-labelledby="limits-h">
        <h2 id="limits-h">Plan limits</h2>
        {account && account.windows.length ? (
          <>
            {account.windows.map((w) => {
              const pct = Math.min(100, Math.max(0, w.utilization));
              const reset = resetsIn(w.resetsAt, now);
              return (
                <div className="limit" key={w.name}>
                  <div className="limit-head">
                    <strong>{humanizeWindow(w.name)}</strong>
                    <span className="num">{Math.round(pct)}%{reset ? <span className="muted"> · {reset}</span> : null}</span>
                  </div>
                  <div className="bar" role="progressbar" aria-label={humanizeWindow(w.name)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                    <span className={pct >= 90 ? "crit" : pct >= 70 ? "warn" : ""} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            <p className="faint" style={{ marginBottom: 0 }}>Account-wide, updated {ago(account.fetchedAt, now)}.</p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No plan-limit data yet. It is sent by the Chrome extension when you enable
            {" "}<strong>Poll account usage</strong> in its options.
          </p>
        )}
      </section>

      <nav className="tabs" aria-label="Time window">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "today" ? "/" : `/?w=${t.key}`} aria-current={t.key === win ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      <section aria-label="Totals">
        <div className="totals">
          <div className="stat"><div className="v num">{approx}{total.messages.toLocaleString("en-US")}</div><div className="k">Messages</div></div>
          <div className="stat"><div className="v num">{approx}{fmtTokens(total.promptTokens)}</div><div className="k">Input tokens</div></div>
          <div className="stat"><div className="v num">{approx}{fmtTokens(total.outputTokens)}</div><div className="k">Output tokens</div></div>
        </div>
        <p className="faint">
          Totals cover devices seen in the last 10 minutes. Claude Code input includes cache reads.
          {estimated ? " ≈ marks estimated values (Chrome counts are character-based)." : ""}
        </p>
      </section>

      <section className="card" aria-labelledby="matrix-h">
        <h2 id="matrix-h">Devices × models</h2>
        {devices.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No devices have reported yet. Point a client at this hub (see docs/11-hub.md).</p>
        ) : (
          <div className="scroll" tabIndex={0} role="region" aria-label="Device by model usage table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  {models.map((m) => <th scope="col" key={m} title={m}>{shortModel(m)}</th>)}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const w = d.windows[win];
                  return (
                    <tr key={d.deviceId} className={d.fresh ? "" : "stale"}>
                      <th scope="row">
                        {d.deviceName || d.deviceId.slice(0, 8)}
                        <span className="badge">{SOURCE_LABEL[d.source] ?? d.source}</span>
                        {d.fresh ? null : <span className="badge stale">stale</span>}
                        <span className="sub faint" style={{ display: "block", fontWeight: 400 }}>seen {ago(d.receivedAt, now)}</span>
                      </th>
                      {models.map((m) => {
                        const c = w.byModel[m];
                        return (
                          <td className="num" key={m}>
                            {c ? <>{d.estimated ? "≈" : ""}{c.messages}<span className="sub">{fmtTokens(c.tokens)} tok</span></> : <span className="faint">-</span>}
                          </td>
                        );
                      })}
                      <td className="num"><strong>{d.estimated ? "≈" : ""}{w.messages}</strong><span className="sub">{fmtTokens(w.promptTokens + w.outputTokens)} tok</span></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total (fresh)</th>
                  {models.map((m) => {
                    const c = total.byModel[m];
                    return (
                      <td className="num" key={m}>
                        {c ? <>{approx}{c.messages}<span className="sub">{fmtTokens(c.tokens)} tok</span></> : <span className="faint">-</span>}
                      </td>
                    );
                  })}
                  <td className="num">{approx}{total.messages}<span className="sub">{fmtTokens(total.promptTokens + total.outputTokens)} tok</span></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <div className="charts">
        <section className="card" aria-labelledby="models-h">
          <h2 id="models-h">Tokens per model</h2>
          <ModelBars byModel={total.byModel} order={models} />
        </section>
        <section className="card" aria-labelledby="daily-h">
          <h2 id="daily-h">Daily tokens by device (30 days)</h2>
          <DailyChart
            rows={daily}
            devices={devices.map((d) => ({ id: d.deviceId, name: d.deviceName || d.deviceId.slice(0, 8) }))}
            today={dayInTz(now, hubTz())}
          />
          <p className="faint" style={{ marginBottom: 0 }}>Based on each device&apos;s &quot;today&quot; snapshots; days follow {hubTz()}.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="dev-h">
        <h2 id="dev-h">Devices</h2>
        {devices.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : devices.map((d) => (
          <div className="dev" key={d.deviceId}>
            <div>
              <strong>{d.deviceName || d.deviceId.slice(0, 8)}</strong>
              <span className="badge">{SOURCE_LABEL[d.source] ?? d.source}</span>
              <div className="faint">last seen {ago(d.receivedAt, now)} · id {d.deviceId.slice(0, 12)}</div>
            </div>
            <DeleteDevice id={d.deviceId} name={d.deviceName || d.deviceId} />
          </div>
        ))}
      </section>
    </main>
  );
}
