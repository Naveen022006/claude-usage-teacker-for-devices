// Extra CSS for the sidebar panel. Inherits font and colour from claude.ai's sidebar (host: font/color inherit);
// light/dark is decided from the sidebar text luminance (data-theme on the host), never prefers-color-scheme.

export const SIDEBAR_CSS = `
.wrap.sidebar {
  font: inherit; font-size: 12.5px; line-height: 1.35; color: inherit; width: 100%;
  --ok: #2f8f5b; --warn: #b9770e; --bad: #c8402f; --accent: #c15f3c;
  --line: color-mix(in srgb, currentColor 14%, transparent);
  --soft: color-mix(in srgb, currentColor 6%, transparent);
}
:host([data-theme="dark"]) .wrap.sidebar { --ok: #5fc08a; --warn: #e0a84a; --bad: #f0786a; --accent: #d97757; }
.wrap.sidebar button { color: inherit; font: inherit; }
.sb { margin: 2px 0 6px; padding: 4px 10px 10px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); }
.sb-head { display: flex; align-items: center; gap: 4px; min-height: 28px; }
.sb-toggle { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; background: none; border: 0; padding: 3px 0; text-align: left; font-weight: 600; }
.sb-toggle .chev { opacity: .65; transition: transform .12s; }
.sb.open .sb-toggle .chev { transform: rotate(90deg); }
.sb-peek { margin-left: auto; font-weight: 500; font-size: 12px; opacity: .65; font-variant-numeric: tabular-nums; }
.sb .icon-btn { width: 24px; height: 24px; border-radius: 6px; color: inherit; opacity: .55; }
.sb .icon-btn:hover { opacity: 1; background: var(--line); }
.sb-body { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
.sb-plan { display: flex; flex-direction: column; gap: 8px; }
.sb-win-top { display: flex; align-items: baseline; gap: 8px; }
.sb-win-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-win-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.sb-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin: 4px 0 3px; }
.sb-fill { height: 100%; border-radius: 2px; background: var(--ok); }
.sb-fill.t-warn { background: var(--warn); } .sb-fill.t-bad { background: var(--bad); }
.sb-reset { font-size: 11.5px; opacity: .65; font-variant-numeric: tabular-nums; }
.sb-compact { display: flex; flex-direction: column; gap: 5px; }
.sb-crow { display: grid; grid-template-columns: 1fr auto auto; column-gap: 8px; align-items: baseline; font-size: 11.5px; }
.sb-crow .sb-bar { grid-column: 1 / -1; height: 3px; margin: 2px 0 0; }
.sb-crow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.sb-crow .pc { font-weight: 600; font-variant-numeric: tabular-nums; }
.sb-crow .rs { opacity: .65; font-variant-numeric: tabular-nums; }
.sb-none { opacity: .65; font-size: 11.5px; }
.sb-seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--soft); border: 1px solid var(--line); }
.sb-seg button { flex: 1; border: 0; background: none; padding: 3px 2px; border-radius: 6px; font-size: 11.5px; opacity: .7; white-space: nowrap; }
.sb-seg button[aria-selected="true"] { background: var(--line); opacity: 1; font-weight: 600; }
.sb-dev { display: flex; flex-direction: column; gap: 6px; }
.sb-cap { font-size: 11.5px; opacity: .65; display: flex; justify-content: space-between; gap: 8px; }
.sb-m { display: grid; grid-template-columns: 1fr auto auto; column-gap: 8px; align-items: baseline; }
.sb-m .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.sb-m .nm small { font-weight: 400; opacity: .65; margin-left: 5px; font-size: 11px; }
.sb-m .pc { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; min-width: 3ch; }
.sb-m .tk { opacity: .65; font-variant-numeric: tabular-nums; text-align: right; font-size: 11.5px; min-width: 9ch; }
.sb-m .sb-bar { grid-column: 1 / -1; height: 3px; margin: 2px 0 4px; }
.sb-m .sb-fill { background: color-mix(in srgb, currentColor 55%, transparent); }
.sb-msg { font-size: 12px; opacity: .85; }
.sb-link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; text-align: left; }
.sb-list.scroll { max-height: 240px; overflow-y: auto; }
`;
