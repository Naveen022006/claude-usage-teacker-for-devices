// Pure, incremental Server-Sent-Events parser. Never throws.

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private hasData = false;
  private id: string | undefined;
  private lastWasCR = false;

  /** Feed a decoded text chunk; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    try {
      if (typeof chunk !== "string" || !chunk) return out;
      let s = chunk;
      // A CR at the end of the previous chunk may be followed by LF here.
      if (this.lastWasCR && s[0] === "\n") s = s.slice(1);
      this.lastWasCR = false;
      s = this.buf + s;
      this.buf = "";
      let start = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c !== "\n" && c !== "\r") continue;
        if (c === "\r") {
          if (i + 1 < s.length) {
            if (s[i + 1] === "\n") i++;
          } else {
            this.lastWasCR = true;
          }
        }
        this.line(s.slice(start, c === "\r" && s[i] === "\n" ? i - 1 : i), out);
        start = i + 1;
      }
      this.buf = s.slice(start);
    } catch {
      /* fail soft */
    }
    return out;
  }

  /** End of stream: process a trailing unterminated line and dispatch any pending event. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    try {
      if (this.buf) this.line(this.buf, out);
      this.buf = "";
      this.lastWasCR = false;
      this.dispatch(out);
    } catch {
      /* fail soft */
    }
    return out;
  }

  private line(l: string, out: SseEvent[]): void {
    if (l === "") return this.dispatch(out);
    if (l[0] === ":") return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") {
      this.data.push(value);
      this.hasData = true;
    } else if (field === "id") this.id = value;
  }

  private dispatch(out: SseEvent[]): void {
    if (this.hasData || this.event) {
      const e: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
      if (this.id !== undefined) e.id = this.id;
      out.push(e);
    }
    this.event = "";
    this.data = [];
    this.hasData = false;
    this.id = undefined;
  }
}
