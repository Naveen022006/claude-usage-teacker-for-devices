// Finds where the usage panel goes inside claude.ai's left sidebar and keeps it attached across
// React re-renders and SPA navigation. DOM-only (no chrome.*), unit-tested with happy-dom fixtures.
//
//   chat  (path not starting with /code): directly below the "Customize" row (above "Pinned")
//   code  (path starting with /code):     directly below the "More" row (above "Recents")
//
// Selectors here are the fragile part (claude.ai's markup is undocumented): everything fails soft
// and the caller falls back to the floating pill when no usable anchor is found.

export type Mode = "chat" | "code";
export type Placement = "sidebar" | "floating";

export const HOST_ATTR = "data-claude-usage-host";
export const MIN_SIDEBAR_WIDTH = 120;

export function detectMode(pathname: string): Mode {
  return pathname.startsWith("/code") ? "code" : "chat";
}

const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const inOurHost = (el: Element): boolean => !!el.closest(`[${HOST_ATTR}]`);

/** Candidate sidebar containers; <body> is the last resort (anchors there must still be left-aligned and wide enough). */
export function sidebarRoots(doc: Document): Element[] {
  const roots = Array.from(doc.querySelectorAll('nav, [aria-label*="sidebar" i], aside')).filter((e) => !inOurHost(e));
  if (doc.body) roots.push(doc.body);
  return roots;
}

/** Visible, at least 120px wide and sitting on the left part of the screen (not a collapsed/hidden sidebar). */
export function isUsableAnchor(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIDEBAR_WIDTH && r.height > 0 && r.left < 500;
  } catch {
    return false;
  }
}

/**
 * Climbs from a matching element to the row wrapper: the highest ancestor (below `root`) whose visible text is
 * still the same as the element's, i.e. which does not yet contain sibling rows.
 */
export function climbToRow(el: Element, root: Element): Element {
  const text = norm(el.textContent);
  let cur = el;
  while (cur.parentElement && cur.parentElement !== root && cur.parentElement !== el.ownerDocument.body && cur.parentElement !== el.ownerDocument.documentElement) {
    if (norm(cur.parentElement.textContent) !== text) break;
    cur = cur.parentElement;
  }
  return cur;
}

export interface Anchor {
  row: Element;
  via: "href" | "label" | "fallback";
}

export interface FindOptions {
  /** Defaults to isUsableAnchor. Tests override it because happy-dom has no layout. */
  usable?: (row: Element) => boolean;
}

function rowsByLabel(roots: Element[], label: string, tags: string, usable: (e: Element) => boolean): Element | null {
  const want = norm(label);
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(tags))) {
      if (inOurHost(el) || norm(el.textContent) !== want) continue;
      const row = climbToRow(el, root);
      if (usable(row)) return row;
    }
  }
  return null;
}

function isInteractive(el: Element): boolean {
  return el.matches("a[href], button, [role=button], [role=link]");
}

function fontPx(el: Element): number {
  try {
    return parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).fontSize ?? "") || 99;
  } catch {
    return 99;
  }
}

/**
 * Language-tolerant fallback for chat mode: the last nav row before the first section heading
 * ("Pinned" / "Recents" in any language). Needs >= 3 rows before the heading.
 */
function chatFallback(roots: Element[], usable: (e: Element) => boolean): Element | null {
  for (const root of roots) {
    if (root === root.ownerDocument.body) continue; // too broad for a heuristic
    const all = Array.from(root.querySelectorAll("*")).filter((e) => !inOurHost(e));
    const rows: Element[] = [];
    for (const el of all) {
      if (isInteractive(el)) {
        const t = norm(el.textContent);
        if (t && t.length <= 30 && !el.parentElement?.closest("a[href], button, [role=button], [role=link]")) rows.push(el);
        continue;
      }
      if (rows.length < 3 || el.closest("a[href], button, [role=button], [role=link]")) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 24 || el.querySelector("a[href], button, [role=button]")) continue;
      const isHeading = el.matches('h1, h2, h3, h4, [role="heading"]') || fontPx(el) <= 12.5;
      if (!isHeading) continue;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = climbToRow(rows[i], root);
        if (usable(row)) return row;
      }
      return null;
    }
  }
  return null;
}

export function findAnchor(doc: Document, mode: Mode, opts: FindOptions = {}): Anchor | null {
  const usable = opts.usable ?? isUsableAnchor;
  const roots = sidebarRoots(doc);
  if (mode === "chat") {
    for (const root of roots) {
      for (const a of Array.from(root.querySelectorAll('a[href*="/customize"]'))) {
        if (inOurHost(a)) continue;
        const row = climbToRow(a, root);
        if (usable(row)) return { row, via: "href" };
      }
    }
    const byLabel = rowsByLabel(roots, "Customize", "a, button, [role=button], [role=link], div, span, li", usable);
    if (byLabel) return { row: byLabel, via: "label" };
    const fb = chatFallback(roots, usable);
    return fb ? { row: fb, via: "fallback" } : null;
  }
  const more = rowsByLabel(roots, "More", "a, button, [role=button], [role=link], div, span, li", usable);
  return more ? { row: more, via: "label" } : null;
}

/** Cheap re-validation that `row` is still the anchor for `mode` (label/href based; fallback anchors are trusted). */
export function rowMatches(row: Element, mode: Mode, via: string | undefined): boolean {
  if (via === "fallback") return true;
  const t = norm(row.textContent);
  if (mode === "code") return t === "more";
  return t === "customize" || !!(row.matches('a[href*="/customize"]') || row.querySelector('a[href*="/customize"]'));
}

export interface PlaceResult {
  placement: Placement;
  mode: Mode;
  /** The row our host sits below (sidebar placement only). */
  row: Element | null;
  /** True if the host was (re)inserted or moved by this call. */
  changed: boolean;
}

/**
 * Idempotent: makes sure `host` exists exactly once in the DOM, right after the anchor row when one is
 * usable, else appended to <body> (floating). Never inserts inside React-owned nodes: always a sibling.
 */
export function placeHost(host: HTMLElement, doc: Document, pathname: string, opts: FindOptions = {}): PlaceResult {
  const usable = opts.usable ?? isUsableAnchor;
  const mode = detectMode(pathname);
  // Remove stray duplicates (e.g. a second content-script instance after an extension reload).
  for (const d of Array.from(doc.querySelectorAll(`[${HOST_ATTR}]`))) if (d !== host) d.remove();

  const prev = host.previousElementSibling;
  if (host.isConnected && host.dataset.placement === "sidebar" && host.dataset.mode === mode && prev && prev.isConnected && rowMatches(prev, mode, host.dataset.via) && usable(prev)) {
    return { placement: "sidebar", mode, row: prev, changed: false };
  }
  const anchor = findAnchor(doc, mode, { usable });
  if (anchor) {
    const changed = host.previousElementSibling !== anchor.row || !host.isConnected;
    if (changed) anchor.row.after(host);
    host.dataset.placement = "sidebar";
    host.dataset.mode = mode;
    host.dataset.via = anchor.via;
    return { placement: "sidebar", mode, row: anchor.row, changed };
  }
  const parent = doc.body ?? doc.documentElement;
  const changed = host.parentElement !== parent || host.dataset.placement !== "floating" || !host.isConnected;
  if (changed) parent.append(host);
  host.dataset.placement = "floating";
  host.dataset.mode = mode;
  return { placement: "floating", mode, row: null, changed };
}

/**
 * Calls `check` (throttled to ~4/s, aligned to animation frames) whenever the DOM mutates, on popstate /
 * hashchange / Navigation API events and on a 2 s heartbeat (SPA route changes). Returns a stop function.
 */
export function watchPlacement(check: () => void, win: Window = window, minGapMs = 250): () => void {
  const doc = win.document;
  let scheduled = false;
  let last = 0;
  let stopped = false;
  let t: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    scheduled = false;
    if (stopped) return;
    last = Date.now();
    try {
      check();
    } catch {
      /* fail soft */
    }
  };
  const trigger = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    const wait = Math.max(0, minGapMs - (Date.now() - last));
    t = setTimeout(() => (typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame(run) : run()), wait);
  };
  const mo = new (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(trigger);
  mo.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  win.addEventListener("popstate", trigger);
  win.addEventListener("hashchange", trigger);
  const nav = (win as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener?.("navigatesuccess", trigger);
  const beat = setInterval(trigger, 2000);
  return () => {
    stopped = true;
    mo.disconnect();
    clearTimeout(t);
    clearInterval(beat);
    win.removeEventListener("popstate", trigger);
    win.removeEventListener("hashchange", trigger);
    nav?.removeEventListener?.("navigatesuccess", trigger);
  };
}
