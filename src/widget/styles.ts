// Widget stylesheet (adopted into the closed shadow root). Light/dark follow prefers-color-scheme.

export const WIDGET_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: #faf9f5; --surface: #ffffff; --surface2: #f0eee6; --border: #ddd9cc; --text: #1f1e1d; --muted: #5e5d59;
  --accent: #c15f3c; --ok: #2f7d4f; --warn: #b7791f; --bad: #c0392b; --track: #e6e2d6; --shadow: 0 6px 24px rgba(0,0,0,.16);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text);
}
@media (prefers-color-scheme: dark) {
  .wrap {
    --bg: #262624; --surface: #30302e; --surface2: #3a3936; --border: #4a4945; --text: #f0eee6; --muted: #b8b5a9;
    --accent: #d97757; --ok: #5fc08a; --warn: #e0a84a; --bad: #f0786a; --track: #444340; --shadow: 0 6px 24px rgba(0,0,0,.5);
  }
}
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, .panel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted { color: var(--muted); }
.small { font-size: 11.5px; }
.t-ok { --c: var(--ok); } .t-warn { --c: var(--warn); } .t-bad { --c: var(--bad); } .t-none { --c: var(--muted); }

.pill {
  display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 14px 0 11px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 22px; box-shadow: var(--shadow); touch-action: none; user-select: none;
}
.pill:hover { background: var(--surface2); }
.pill-text { font-weight: 600; font-variant-numeric: tabular-nums; }
.track { stroke: var(--track); }
.arc { stroke: var(--c, var(--muted)); }
.arc.t-ok { stroke: var(--ok); } .arc.t-warn { stroke: var(--warn); } .arc.t-bad { stroke: var(--bad); }

.panel {
  width: 340px; max-width: calc(100vw - 32px); max-height: 70vh; display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
}
.head { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 8px 14px; border-bottom: 1px solid var(--border); }
.title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; flex: 1; cursor: ns-resize; touch-action: none; user-select: none; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.head-actions { display: flex; gap: 2px; }
.icon-btn { background: none; border: 0; border-radius: 8px; width: 30px; height: 30px; display: grid; place-items: center; color: var(--muted); }
.icon-btn:hover { background: var(--surface2); color: var(--text); }

.body { overflow-y: auto; padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.plan { display: flex; flex-direction: column; gap: 10px; }
.win-top { display: flex; justify-content: space-between; margin-bottom: 4px; }
.win-name { font-weight: 500; } .win-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.bar, .mbar { height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; }
.fill { height: 100%; background: var(--c, var(--ok)); border-radius: 4px; }
.fill.t-ok { background: var(--ok); } .fill.t-warn { background: var(--warn); } .fill.t-bad { background: var(--bad); }

.tabs { display: flex; gap: 2px; padding: 3px; background: var(--surface2); border-radius: 9px; }
.tab { flex: 1; border: 0; background: none; padding: 5px 4px; border-radius: 7px; font-size: 12px; color: var(--muted); }
.tab[aria-selected="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.12); }

.devices { display: flex; flex-direction: column; gap: 8px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.card.is-stale { opacity: .78; }
.card-head { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: 0; padding: 2px 0; text-align: left; flex-wrap: wrap; }
.chev { transition: transform .12s; flex: none; color: var(--muted); }
.card.open .chev { transform: rotate(90deg); }
.card-title { font-weight: 600; }
.badge { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
.stale { font-size: 11px; color: var(--warn); width: 100%; padding-left: 20px; }
.totals { color: var(--muted); font-size: 12px; padding: 2px 0 6px 20px; font-variant-numeric: tabular-nums; }
.mrow { display: grid; grid-template-columns: 1fr auto auto; column-gap: 10px; row-gap: 3px; align-items: baseline; padding: 4px 0 4px 20px; }
.mname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnum { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.mbar { grid-column: 1 / -1; height: 4px; }
.mfill { height: 100%; background: var(--accent); border-radius: 2px; }

.dev-head { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 4px; }
.mrow.dev { grid-template-columns: 1fr auto auto; }
.mrow.dev.other .mname { color: var(--muted); font-weight: 400; }
.dev-note { padding: 0 0 2px 20px; }
.dev-badge { font-size: 10.5px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); white-space: nowrap; }
.dev-badge.high { color: var(--ok); }
.dev-badge.medium { color: var(--blue); }
.dev-badge.low { color: var(--warn); }

.foot { display: flex; flex-direction: column; gap: 2px; padding: 8px 14px 10px; border-top: 1px solid var(--border); }
.err { color: var(--bad); }
.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; text-align: left; font-size: 11.5px; }
p { margin: 0; }
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
`;
