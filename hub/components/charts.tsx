import { fmtTokens, shortModel } from "@/lib/format";
import type { DailyRow } from "@/lib/store";

/** Fixed-order categorical slots; the 9th+ entity folds into "other" (muted). */
export const slotVar = (i: number) => (i < 8 ? `var(--s${i + 1})` : "var(--s-other)");

export function ModelBars({ byModel, order }: { byModel: Record<string, { messages: number; tokens: number }>; order: string[] }) {
  const rows = order.filter((m) => byModel[m]).sort((a, b) => byModel[b].tokens - byModel[a].tokens);
  const max = Math.max(1, ...rows.map((m) => byModel[m].tokens));
  if (!rows.length) return <p className="muted">No model usage in this window.</p>;
  return (
    <div role="list" aria-label="Tokens per model">
      {rows.map((m) => (
        <div className="hbar" role="listitem" key={m}>
          <span className="name" title={m}>{shortModel(m)}</span>
          <span className="track">
            <span
              className="fill"
              style={{ display: "block", width: `${(byModel[m].tokens / max) * 100}%`, background: slotVar(order.indexOf(m)) }}
            />
          </span>
          <span className="num">
            {fmtTokens(byModel[m].tokens)} <span className="faint">· {byModel[m].messages} msg</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function lastDays(n: number, today: string): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

export function DailyChart({ rows, devices, today }: { rows: DailyRow[]; devices: { id: string; name: string }[]; today: string }) {
  const days = lastDays(30, today);
  const order = [...devices].sort((a, b) => a.id.localeCompare(b.id));
  const idx = new Map(order.map((d, i) => [d.id, i]));
  const byDay = new Map<string, number[]>();
  for (const d of days) byDay.set(d, order.map(() => 0));
  for (const r of rows) {
    const i = idx.get(r.deviceId);
    const arr = byDay.get(r.day);
    if (i !== undefined && arr) arr[i] += r.tokens;
  }
  const totals = days.map((d) => (byDay.get(d) ?? []).reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  if (!totals.some((t) => t > 0)) return <p className="muted">No daily history yet. It builds up as devices report.</p>;

  const W = 720, H = 220, L = 40, R = 8, T = 8, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const bw = iw / days.length;
  const y = (v: number) => T + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * max);

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily tokens by device, last 30 days">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 6} y={y(t) + 3} textAnchor="end">{fmtTokens(t)}</text>
          </g>
        ))}
        {days.map((d, di) => {
          let acc = 0;
          const vals = byDay.get(d) ?? [];
          return (
            <g key={d}>
              {vals.map((v, si) => {
                if (v <= 0) return null;
                const y1 = y(acc + v), h = y(acc) - y1;
                acc += v;
                return (
                  <rect
                    key={si}
                    x={L + di * bw + 1}
                    y={y1}
                    width={Math.max(1, bw - 2)}
                    height={Math.max(0.5, h)}
                    fill={slotVar(si)}
                    stroke="var(--surface)"
                    strokeWidth={1}
                  >
                    <title>{`${d} · ${order[si].name}: ${fmtTokens(v)} tokens`}</title>
                  </rect>
                );
              })}
              {di % 5 === 0 || di === days.length - 1 ? (
                <text x={L + di * bw + bw / 2} y={H - 6} textAnchor="middle">{d.slice(5)}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ul className="legend" aria-label="Devices">
        {order.map((d, i) => (
          <li key={d.id}><i style={{ background: slotVar(i) }} />{d.name}</li>
        ))}
      </ul>
      <details>
        <summary>View as table</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr><th scope="col">Day</th>{order.map((d) => <th scope="col" key={d.id}>{d.name}</th>)}</tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  {(byDay.get(d) ?? []).map((v, i) => <td className="num" key={i}>{v ? fmtTokens(v) : "-"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
