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

/** Lowercase letters only: "··· More" -> "more", "Projects Beta" -> "projectsbeta". Immune to icons, dots, spacing. */
export function labelKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");
}

const INTERACTIVE = "a[href], button, [role=button], [role=link], [role=menuitem], [aria-haspopup]";
const ROOT_SEL = 'nav, aside, [aria-label*="sidebar" i]';
const LABEL_TAGS = `${INTERACTIVE}, div, span, li, [aria-label]`;

const inOurHost = (el: Element): boolean => !!el.closest(`[${HOST_ATTR}]`);

/** Closest nav/aside (not ours) containing `el`; <body> only when there is none. */
function rootFor(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.matches(ROOT_SEL) && !inOurHost(p)) return p;
  }
  const doc = el.ownerDocument;
  return doc.body ?? doc.documentElement;
}

/** Candidate sidebar containers; <body> is the last resort (anchors there must still be left-aligned and wide enough). */
export function sidebarRoots(doc: Document): Element[] {
  const roots = Array.from(doc.querySelectorAll(ROOT_SEL)).filter((e) => !inOurHost(e));
  if (doc.body) roots.push(doc.body);
  return roots;
}

/** Visible, at least 120px wide and sitting on the left part of the screen (not a collapsed/hidden sidebar). */
export function isUsableAnchor(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIDEBAR_WIDTH && r.height > 0 && r.left < 400;
  } catch {
    return false;
  }
}

/**
 * Climbs from a matching element to the row wrapper: the highest ancestor (below `root`) whose letters are
 * still the same as the element's, i.e. which does not yet contain sibling rows.
 */
export function climbToRow(el: Element, root: Element): Element {
  const key = labelKey(el.textContent);
  let cur = el;
  while (cur.parentElement && cur.parentElement !== root && cur.parentElement !== el.ownerDocument.body && cur.parentElement !== el.ownerDocument.documentElement) {
    if (labelKey(cur.parentElement.textContent) !== key) break;
    cur = cur.parentElement;
  }
  return cur;
}

export interface Anchor {
  row: Element;
  /** sibling: code mode without a "More" row (below/at Customize); re-checked for a real "More" row later. */
  via: "href" | "label" | "fallback" | "sibling";
}

export interface FindOptions {
  /** Defaults to isUsableAnchor. Tests override it because happy-dom has no layout. */
  usable?: (row: Element) => boolean;
}

/** Elements whose visible text (or aria-label) reduces to `key`; interactive ones first. */
function labelCandidates(doc: Document, key: string): Element[] {
  const scopes: Element[] = Array.from(doc.querySelectorAll(ROOT_SEL)).filter((e) => !inOurHost(e));
  if (doc.body) scopes.push(doc.body);
  const seen = new Set<Element>();
  const inter: Element[] = [];
  const rest: Element[] = [];
  for (const scope of scopes) {
    for (const el of Array.from(scope.querySelectorAll(LABEL_TAGS))) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (inOurHost(el)) continue;
      if (labelKey(el.textContent) !== key && labelKey(el.getAttribute("aria-label")) !== key) continue;
      (el.matches(INTERACTIVE) ? inter : rest).push(el);
    }
  }
  return [...inter, ...rest];
}

function rowByLabel(doc: Document, key: string, usable: (e: Element) => boolean): Element | null {
  for (const el of labelCandidates(doc, key)) {
    const row = climbToRow(el, rootFor(el));
    if (usable(row)) return row;
  }
  return null;
}

function rowByHref(doc: Document, frag: string, usable: (e: Element) => boolean): Element | null {
  for (const a of Array.from(doc.querySelectorAll(`a[href*="${frag}"]`))) {
    if (inOurHost(a)) continue;
    const row = climbToRow(a, rootFor(a));
    if (usable(row)) return row;
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

/** A short non-interactive block ("Recents", "Pinned") rather than a nav row. */
function isSectionHeading(el: Element): boolean {
  if (el.matches('h1, h2, h3, h4, [role="heading"]')) return true;
  if (isInteractive(el) || el.querySelector("a[href], button, [role=button], [role=link]")) return false;
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t.length <= 24 && (t.length > 0 || fontPx(el) <= 12.5);
}

/**
 * Language-tolerant fallback: the last nav row before the first section heading
 * ("Pinned" / "Recents" in any language). Needs >= 3 rows before the heading.
 */
function navFallback(roots: Element[], usable: (e: Element) => boolean): Element | null {
  for (const root of roots) {
    if (root === root.ownerDocument.body) continue; // too broad for a heuristic
    const all = Array.from(root.querySelectorAll("*")).filter((e) => !inOurHost(e));
    const rows: Element[] = [];
    for (const el of all) {
      if (isInteractive(el)) {
        const t = labelKey(el.textContent);
        if (t && t.length <= 30 && !el.parentElement?.closest("a[href], button, [role=button], [role=link]")) rows.push(el);
        continue;
      }
      if (rows.length < 3 || el.closest("a[href], button, [role=button], [role=link]")) continue;
      const t = labelKey(el.textContent);
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

// ---- diagnostics (once per page load + mode) ----

const reported = new Set<Mode>();

/** Test hook. */
export function resetAnchorDiagnostics(): void {
  reported.clear();
}

function reportMissing(doc: Document, mode: Mode): void {
  if (reported.has(mode)) return;
  reported.add(mode);
  try {
    const labels: string[] = [];
    for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
      if (labels.length >= 15) break;
      if (inOurHost(el)) continue;
      let left = 0;
      try {
        left = el.getBoundingClientRect().left;
      } catch {
        /* ignore */
      }
      if (left >= 400) continue;
      const k = (labelKey(el.textContent) || labelKey(el.getAttribute("aria-label"))).slice(0, 30);
      if (k && !labels.includes(k)) labels.push(k);
    }
    console.info(`[claude-usage] sidebar anchor not found (mode=${mode}); candidates:`, labels);
  } catch {
    /* never throw from diagnostics */
  }
}

function findAnchorInner(doc: Document, mode: Mode, usable: (e: Element) => boolean): Anchor | null {
  const roots = sidebarRoots(doc);
  if (mode === "chat") {
    const byHref = rowByHref(doc, "/customize", usable);
    if (byHref) return { row: byHref, via: "href" };
    const byLabel = rowByLabel(doc, "customize", usable);
    if (byLabel) return { row: byLabel, via: "label" };
  } else {
    const more = rowByLabel(doc, "more", usable);
    if (more) return { row: more, via: "label" };
    const cust = rowByHref(doc, "/customize", usable) ?? rowByLabel(doc, "customize", usable);
    if (cust) {
      let sib = cust.nextElementSibling;
      while (sib && inOurHost(sib)) sib = sib.nextElementSibling;
      if (sib && usable(sib) && !isSectionHeading(sib)) return { row: sib, via: "sibling" };
      return { row: cust, via: "sibling" };
    }
  }
  const fb = navFallback(roots, usable);
  return fb ? { row: fb, via: "fallback" } : null;
}

export function findAnchor(doc: Document, mode: Mode, opts: FindOptions = {}): Anchor | null {
  const a = findAnchorInner(doc, mode, opts.usable ?? isUsableAnchor);
  if (!a) reportMissing(doc, mode);
  return a;
}

/** Cheap re-validation that `row` is still the anchor for `mode` (label/href based; fallback anchors are trusted). */
export function rowMatches(row: Element, mode: Mode, via: string | undefined): boolean {
  if (via === "fallback" || via === "sibling") return true;
  const k = labelKey(row.textContent);
  if (mode === "code") return k === "more" || labelKey(row.getAttribute("aria-label")) === "more" || !!Array.from(row.querySelectorAll("[aria-label]")).some((e) => labelKey(e.getAttribute("aria-label")) === "more" && k.startsWith("more"));
  return k === "customize" || !!(row.matches('a[href*="/customize"]') || row.querySelector('a[href*="/customize"]'));
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
  // Code mode without a real "More" row keeps looking for one (it may render later).
  const settled = mode === "chat" || host.dataset.via === "label";
  if (settled && host.isConnected && host.dataset.placement === "sidebar" && host.dataset.mode === mode && prev && prev.isConnected && rowMatches(prev, mode, host.dataset.via) && usable(prev)) {
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
