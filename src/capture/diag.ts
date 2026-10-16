// Capture diagnostics: a small ring of recent /api/ observations plus counters. Never holds message content,
// only redacted path patterns, content types, status codes and SSE event *names*.

import type { CaptureDiag, DiagObservation } from "../shared/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RING = 20;

/** Path of a URL with every id-looking segment (UUID, digits, long token containing a digit) replaced by ":id". */
export function pathPattern(url: string): string {
  let path = typeof url === "string" ? url : "";
  try {
    path = new URL(path, "https://claude.ai").pathname;
  } catch {
    path = path.split(/[?#]/)[0] ?? "";
  }
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (UUID_RE.test(seg) || /^\d+$/.test(seg)) return ":id";
      if (seg.length >= 12 && /\d/.test(seg)) return ":id";
      if (seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg)) return ":id";
      return seg.slice(0, 48);
    })
    .join("/")
    .slice(0, 200);
}

export class DiagState {
  hookInstalled = false;
  fetchCalls = 0;
  streamsSeen = 0;
  emptyStreams = 0;
  eventsPosted = 0;
  private ring: DiagObservation[] = [];

  observe(o: Omit<DiagObservation, "at">): DiagObservation {
    const obs: DiagObservation = { at: Date.now(), ...o };
    this.ring.push(obs);
    if (this.ring.length > RING) this.ring.shift();
    return obs;
  }

  snapshot(): CaptureDiag {
    return {
      updatedAt: Date.now(),
      hookInstalled: this.hookInstalled,
      fetchCalls: this.fetchCalls,
      streamsSeen: this.streamsSeen,
      emptyStreams: this.emptyStreams,
      eventsPosted: this.eventsPosted,
      observations: this.ring.map((o) => ({ ...o, eventTypes: o.eventTypes.slice(0, 15) })),
    };
  }
}
