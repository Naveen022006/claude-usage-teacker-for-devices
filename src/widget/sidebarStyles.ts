// Extra CSS for the sidebar panel: flat rows that blend into claude.ai's sidebar. Inherits font and colour from the host;
// light/dark is decided from the sidebar text luminance (data-theme on the host), never prefers-color-scheme.

export const SIDEBAR_CSS = `
.wrap.sidebar {
  font: inherit; font-size: 13.5px; line-height: 1.35; color: inherit; width: 100%;
  --blue: #1a6fd1; --warn: #b9770e; --bad: #c8402f; --accent: #1a6fd1;
  --muted: color-mix(in srgb, currentColor 60%, transparent);
  --line: color-mix(in srgb, currentColor 12%, transparent);
  font-variant-numeric: tabular-nums;
}
:host([data-theme="dark"]) .wrap.sidebar { --blue: #5aa9ff; --warn: #e0a84a; --bad: #f0786a; --accent: #5aa9ff; }
.wrap.sidebar button { color: inherit; font: inherit; cursor: pointer; }
.sb { margin: 4px 0 8px; padding: 0 10px; display: flex; flex-direction: column; gap: 10px; }
.sb-head { display: flex; align-items: center; justify-content: space-between; min-height: 24px; }
.sb-toggle { background: none; border: 0; padding: 2px 0; text-align: left; font-size: 13px; color: var(--muted); }
.sb-toggle:hover { color: inherit; }
.sb .icon-btn { width: 24px; height: 24px; border-radius: 6px; background: none; border: 0; display: grid; place-items: center; color: var(--blue); }
.sb .icon-btn:hover { background: var(--line); }
.sb button:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; border-radius: 4px; }
/* label shrinks (ellipsis), % has its own fixed column, countdown/tokens never shrink — nothing can overlap */
.sb-row { display: grid; grid-template-columns: minmax(0, 1fr) 3.3em auto; column-gap: 8px; align-items: baseline; }
.sb-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-pct { color: var(--blue); white-space: nowrap; }
.sb-row.mdl { grid-template-columns: minmax(0, 1fr) 4.6em auto; }
.sb-mid { color: var(--muted); white-space: nowrap; font-size: 12.5px; }
.sb-pct.none { color: var(--muted); }
.sb-fill.neutral { background: color-mix(in srgb, currentColor 45%, transparent); }
.sb-plan { font-size: 11.5px; opacity: .85; }
.sb-row.txt { grid-template-columns: auto minmax(0, 1fr) auto; }
.sb-row.txt .sb-pct { white-space: normal; text-align: right; line-height: 1.25; }
.sb-pct.t-warn, .sb-fill.t-warn { --blue: var(--warn); }
.sb-pct.t-bad, .sb-fill.t-bad { --blue: var(--bad); }
.sb-right { justify-self: end; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; font-size: 12.5px; }
.sb-right .clk { flex: none; position: relative; top: 1px; }
.sb-bar { height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; margin-top: 6px; }
.sb-fill { height: 100%; border-radius: 2px; background: var(--blue); min-width: 2px; }
.sb-none, .sb-msg { color: var(--muted); font-size: 12.5px; }
.sb-diag { color: var(--muted); font-size: 11.5px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; }
.sb-diag.cut { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
.sb-link { background: none; border: 0; padding: 0; color: var(--blue); text-decoration: underline; text-align: left; }
.sb-row.attr { grid-template-columns: minmax(0, 1fr) 3em 3em 4.4em; }
.sb-row.attr .sb-pts { color: var(--blue); text-align: right; white-space: nowrap; }
.sb-row.attr .tk { color: var(--muted); text-align: right; white-space: nowrap; font-size: 12.5px; }
.sb-row.attr.other .sb-lbl, .sb-row.attr.other .sb-pts { color: var(--muted); }
.sb-dev-lbl { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.3; }
.sb-item.sb-dev.other .sb-dev-lbl { color: var(--muted); }
.sb-row.dev { grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 8px; margin-top: 2px; }
.sb-row.dev .sb-pts:first-child { text-align: left; }
.sb-row.dev .sb-pts { white-space: nowrap; }
.sb-row.dev .sb-pts.sh { text-align: right; }
.sb-row.dev .sb-pts.sh { color: var(--muted); font-size: 12.5px; }
.sb-row.dev.other .sb-lbl, .sb-row.dev.other .sb-pts { color: var(--muted); }
/* tinted pill: the base .dev-badge in styles.ts uses --surface2, which follows the OS scheme, so override it here */
.wrap.sidebar .dev-badge { font-size: 10.5px; padding: 0 6px; border-radius: 8px; text-align: center; white-space: nowrap; cursor: help; }
.wrap.sidebar .dev-badge.high { color: color-mix(in srgb, var(--blue) 85%, #000); background: color-mix(in srgb, var(--blue) 14%, transparent); border: 1px solid color-mix(in srgb, var(--blue) 35%, transparent); }
.wrap.sidebar .dev-badge.medium { color: color-mix(in srgb, currentColor 70%, transparent); background: color-mix(in srgb, currentColor 9%, transparent); border: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
.wrap.sidebar .dev-badge.low { color: color-mix(in srgb, var(--warn) 75%, #000); background: color-mix(in srgb, var(--warn) 16%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
:host([data-theme="dark"]) .wrap.sidebar .dev-badge.high { color: var(--blue); }
:host([data-theme="dark"]) .wrap.sidebar .dev-badge.low { color: var(--warn); }
:host([data-theme="dark"]) .wrap.sidebar .dev-badge.medium { color: color-mix(in srgb, currentColor 80%, transparent); }
.sb-sub.sb-cols { display: grid; grid-template-columns: minmax(0, 1fr) 3em 3em 4.4em; column-gap: 8px; font-size: 12px; }
.sb-sub.sb-cols .c { text-align: right; font-size: 11.5px; }
.sb-sub { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.sb-switch { display: inline-flex; align-items: baseline; gap: 5px; }
.sb-switch button { background: none; border: 0; padding: 0 1px; color: var(--muted); font-size: 12.5px; }
.sb-switch button:hover { color: inherit; }
.sb-switch button.on { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
`;
