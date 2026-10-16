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
.sb-pct.t-warn, .sb-fill.t-warn { --blue: var(--warn); }
.sb-pct.t-bad, .sb-fill.t-bad { --blue: var(--bad); }
.sb-right { justify-self: end; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; font-size: 12.5px; }
.sb-right .clk { flex: none; position: relative; top: 1px; }
.sb-bar { height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; margin-top: 6px; }
.sb-fill { height: 100%; border-radius: 2px; background: var(--blue); min-width: 2px; }
.sb-none, .sb-msg { color: var(--muted); font-size: 12.5px; }
.sb-link { background: none; border: 0; padding: 0; color: var(--blue); text-decoration: underline; text-align: left; }
.sb-sub { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.sb-switch { display: inline-flex; align-items: baseline; gap: 5px; }
.sb-switch button { background: none; border: 0; padding: 0 1px; color: var(--muted); font-size: 12.5px; }
.sb-switch button:hover { color: inherit; }
.sb-switch button.on { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
`;
