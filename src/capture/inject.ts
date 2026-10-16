// MAIN world, document_start. Observes claude.ai completion streams via tee(); never alters them.

import { NS } from "../shared/messages";
import type { PageMessage } from "../shared/messages";
import { createClaudeStreamParser, isCompletionUrl, parseRequestMeta } from "./claudeParser";
import type { RequestMeta } from "./claudeParser";
import { SseParser } from "./sse";

const FLAG = Symbol.for("claude-usage.fetch-hooked");
const seenOrgs = new Set<string>();

function post(msg: PageMessage): void {
  try {
    window.postMessage(msg, location.origin);
  } catch {
    /* ignore */
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function noteOrg(meta: RequestMeta): void {
  if (meta.orgId && !seenOrgs.has(meta.orgId)) {
    seenOrgs.add(meta.orgId);
    post({ ns: NS, type: "org-seen", payload: { orgId: meta.orgId } });
  }
}

async function parseStream(stream: ReadableStream<Uint8Array>, metaP: Promise<RequestMeta>): Promise<void> {
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
  post({ ns: NS, type: "usage-event", payload: parser.finish(outcome) });
}

/** Resolve request metadata without blocking the page; only ever reads a clone. */
async function requestMeta(url: string, input: RequestInfo | URL, init?: RequestInit): Promise<RequestMeta> {
  let body: unknown = init?.body;
  if (typeof body !== "string" && input instanceof Request) {
    try {
      body = await input.clone().text();
    } catch {
      body = undefined;
    }
  }
  return parseRequestMeta(url, typeof body === "string" ? body : undefined) ?? { kind: "new", promptChars: 0 };
}

function install(): void {
  const w = window as unknown as Record<symbol, unknown>;
  if (w[FLAG]) return;
  w[FLAG] = true;
  const orig = window.fetch;

  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    let metaP: Promise<RequestMeta> | null = null;
    try {
      const url = urlOf(args[0]);
      if (isCompletionUrl(url)) {
        // Started before orig() so a Request body is cloned before the page consumes it.
        metaP = requestMeta(url, args[0], args[1]);
        metaP.then(noteOrg, () => {});
      }
    } catch {
      metaP = null;
    }
    const res = await orig.apply(this ?? window, args);
    try {
      // Non-2xx (e.g. 429 rate limit) carries a JSON error, not a reply — don't count it.
      if (metaP && res.ok && res.body) {
        const [forPage, forUs] = res.body.tee();
        // Build the page's Response before starting our parse; once tee()'d, `res` can't be returned.
        const forPageRes = new Response(forPage, { status: res.status, statusText: res.statusText, headers: res.headers });
        parseStream(forUs, metaP).catch((e) => console.warn("[claude-usage]", e));
        return forPageRes;
      }
    } catch (e) {
      console.warn("[claude-usage]", e);
    }
    return res;
  };
}

try {
  install();
} catch (e) {
  console.warn("[claude-usage]", e);
}
