// MAIN world, document_start. Observes claude.ai completion streams via tee(); never alters them.
// A response is a candidate when it is a same-origin /api/ call AND (URL matches the known completion regex
// OR the response is text/event-stream). Only chat-completion paths are recorded;
// other event streams are observed for diagnostics only. Only lengths and event names are kept, never text.

import { NS } from "../shared/messages";
import type { PageMessage } from "../shared/messages";
import type { DiagObservation } from "../shared/types";
import { createClaudeStreamParser, isChatCompletionPath, isCompletionUrl, parseRequestMetaAny } from "./claudeParser";
import type { RequestMeta } from "./claudeParser";
import { isSettingsPath, shapeOf, looksLikeSessionList } from "./apiShapes";
import { DiagState, pathPattern } from "./diag";
import { SseParser } from "./sse";

const FLAG = Symbol.for("claude-usage.fetch-hooked");
const OURS = Symbol.for("claude-usage.fetch-wrapper");
const LOG = "[claude-usage]";
const seenOrgs = new Set<string>();
const diag = new DiagState();
let diagTimer: ReturnType<typeof setTimeout> | undefined;

function post(msg: PageMessage): void {
  try {
    window.postMessage(msg, location.origin);
  } catch {
    /* ignore */
  }
}

/** Debounced (1 s) diagnostics post. */
function scheduleDiag(): void {
  if (diagTimer !== undefined) return;
  diagTimer = setTimeout(() => {
    diagTimer = undefined;
    post({ ns: NS, type: "diag", payload: diag.snapshot() });
  }, 1000);
}

/** Absolute URL for a string / URL / Request (relative strings resolve against location.href). */
function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function noteOrg(meta: RequestMeta): void {
  if (meta.orgId && !seenOrgs.has(meta.orgId)) {
    seenOrgs.add(meta.orgId);
    post({ ns: NS, type: "org-seen", payload: { orgId: meta.orgId } });
  }
}

async function parseStream(
  stream: ReadableStream<Uint8Array>,
  metaP: Promise<RequestMeta>,
  obs: DiagObservation,
): Promise<void> {
  const meta = await metaP;
  const parser = createClaudeStreamParser(meta, (payload) => post({ ns: NS, type: "limit-hint", payload }));
  const sse = new SseParser();
  const dec = new TextDecoder();
  let outcome: "done" | "error" | "aborted" = "done";
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const e of sse.push(dec.decode(value, { stream: true }))) parser.onEvent(e);
    }
    for (const e of sse.push(dec.decode())) parser.onEvent(e);
    for (const e of sse.flush()) parser.onEvent(e);
  } catch (e) {
    outcome = e instanceof DOMException && e.name === "AbortError" ? "aborted" : "error";
  }
  const st = parser.stats;
  obs.eventTypes = st.types;
  console.info(LOG, "candidate stream", obs.pathPattern, "events:", st.types.join(",") || "(none)");
  if (st.recognized === 0) {
    diag.emptyStreams++;
    obs.recorded = false;
    obs.reason = `no known reply events (${st.total} events, outcome ${outcome})`;
  } else {
    obs.recorded = true;
    delete obs.reason;
    diag.eventsPosted++;
    post({ ns: NS, type: "usage-event", payload: parser.finish(outcome) });
    console.info(LOG, "event posted", outcome);
  }
  scheduleDiag();
}

/** Resolve request metadata without blocking the page; only ever reads a clone of a JSON body. */
async function requestMeta(url: string, input: RequestInfo | URL, init?: RequestInit): Promise<RequestMeta> {
  let body: unknown = init?.body;
  if (typeof body !== "string" && input instanceof Request) {
    body = undefined;
    try {
      const ct = input.headers.get("content-type") ?? "";
      if (!ct || ct.includes("json") || ct.includes("text")) body = await input.clone().text();
    } catch {
      body = undefined;
    }
  }
  return parseRequestMetaAny(url, typeof body === "string" ? body : undefined);
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (input instanceof Request ? input.method : "GET");
  return String(m).toUpperCase();
}

/** Devices-list discovery: records only the SHAPE of a JSON GET response, from a clone, off the page's path. */
function noteApiShape(u: URL, res: Response): void {
  try {
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > 2_000_000) return;
    const onSettings = isSettingsPath(location.pathname);
    const pattern = pathPattern(u.href);
    const status = res.status;
    res
      .clone()
      .json()
      .then((json) => {
        const shape = shapeOf(json);
        const isList = looksLikeSessionList(shape);
        // Settings may open as a modal over a chat URL, so a session-list-shaped response is recorded on any page.
        if (!onSettings && !isList) return;
        diag.apiShapes.add({ at: Date.now(), method: "GET", pathPattern: pattern, status, shape, looksLikeSessionList: isList });
        scheduleDiag();
      })
      .catch(() => {});
  } catch {
    /* never throw into the page */
  }
}

/** >0 while our outer wrapper synchronously calls into the previous fetch (guards against a page wrapper that calls us). */
let nested = 0;

function wrap(orig: typeof fetch): typeof fetch {
  const wrapped = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    if (nested > 0) return orig.apply(this ?? window, args);
    let metaP: Promise<RequestMeta> | null = null;
    let u: URL | null = null;
    let matched = false;
    let method = "GET";
    try {
      u = resolveUrl(args[0]);
      if (u && u.origin === location.origin && u.pathname.startsWith("/api/")) {
        diag.fetchCalls++;
        matched = isCompletionUrl(u.href);
        method = methodOf(args[0], args[1]);
        if (matched || method === "POST") {
          // Started before orig() so a Request body is cloned before the page consumes it.
          metaP = requestMeta(u.href, args[0], args[1]);
          metaP.then(noteOrg, () => {});
        }
      } else {
        u = null;
      }
    } catch {
      metaP = null;
      u = null;
    }
    let p: Promise<Response>;
    nested++;
    try {
      p = orig.apply(this ?? window, args);
    } finally {
      nested--;
    }
    const res = await p;
    if (!u) return res;
    try {
      const ct = res.headers.get("content-type") ?? "";
      const isSse = ct.includes("text/event-stream");
      if (method === "GET" && !isSse && ct.includes("json")) noteApiShape(u, res);
      if (!matched && !isSse && method !== "POST") return res; // ordinary API chatter: not worth a ring slot
      const obs = diag.observe({
        pathPattern: pathPattern(u.href),
        contentType: ct.slice(0, 80),
        status: res.status,
        matchedRegex: matched,
        eventTypes: [],
        recorded: false,
      });
      const candidate = matched || isSse;
      if (!candidate) {
        obs.reason = "not a completion URL and not text/event-stream";
      } else if (!matched && !isChatCompletionPath(u.href)) {
        // Observed for diagnostics only: background streams (title generation, suggestions) must not count as usage.
        obs.reason = "not a chat completion path";
      } else if (!res.ok) {
        obs.reason = `HTTP ${res.status} (not a reply)`; // e.g. 429 carries a JSON error
      } else if (!res.body) {
        obs.reason = "no response body";
      } else {
        diag.streamsSeen++;
        obs.reason = "stream in progress";
        const [forPage, forUs] = res.body.tee();
        // Build the page's Response before starting our parse; once tee()'d, `res` can't be returned.
        const forPageRes = new Response(forPage, { status: res.status, statusText: res.statusText, headers: res.headers });
        parseStream(forUs, metaP ?? Promise.resolve(parseRequestMetaAny(u.href, undefined)), obs).catch((e) =>
          console.warn(LOG, e),
        );
        scheduleDiag();
        return forPageRes;
      }
      scheduleDiag();
    } catch (e) {
      console.warn(LOG, e);
    }
    return res;
  } as typeof fetch;
  (wrapped as unknown as Record<symbol, unknown>)[OURS] = true;
  return wrapped;
}

function hook(): void {
  const cur = window.fetch;
  if (typeof cur !== "function" || (cur as unknown as Record<symbol, unknown>)[OURS]) return;
  window.fetch = wrap(cur);
}

function install(): void {
  const w = window as unknown as Record<symbol, unknown>;
  if (w[FLAG]) return;
  w[FLAG] = true;
  hook();
  diag.hookInstalled = true;
  console.info(LOG, "fetch hook installed");
  scheduleDiag();
  // If the page replaces window.fetch later, wrap the new one (no double-wrapping: wrappers are marked).
  let n = 0;
  const t = setInterval(() => {
    try {
      hook();
    } catch {
      /* fetch may be frozen */
    }
    if (++n >= 5) clearInterval(t);
  }, 2000);
}

try {
  install();
} catch (e) {
  console.warn(LOG, e);
}
