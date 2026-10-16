import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageEvent } from "../../src/shared/types";
import type { Cursors, ScanOptions, ScanResult } from "./contracts";
import { mergeEvents, parseTranscriptLine } from "./transcript";

const DEFAULT_CHUNK = 1024 * 1024;

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") console.warn(`[deskbuddy-cc] cannot read dir ${dir}: ${e?.code ?? e}`);
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
  }
}

/** Reads [start, end) and returns parsed events plus the offset after the last complete line. */
async function readRange(
  file: string,
  start: number,
  end: number,
  deviceId: string,
  chunkSize: number,
): Promise<{ events: UsageEvent[]; offset: number }> {
  const fh = await open(file, "r");
  const events: UsageEvent[] = [];
  let pos = start;
  let consumed = start;
  let carry: Buffer = Buffer.alloc(0);
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    while (pos < end) {
      const want = Math.min(chunkSize, end - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      let data: Buffer = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      let lineStart = 0;
      let nl: number;
      while ((nl = data.indexOf(0x0a, lineStart)) !== -1) {
        const line = data.toString("utf8", lineStart, nl);
        lineStart = nl + 1;
        const ev = parseTranscriptLine(line, deviceId);
        if (ev) events.push(ev);
      }
      consumed += lineStart;
      carry = data.subarray(lineStart);
    }
  } finally {
    await fh.close();
  }
  return { events, offset: consumed };
}

export async function scan(opts: ScanOptions, chunkSize: number = DEFAULT_CHUNK): Promise<ScanResult> {
  const files: string[] = [];
  await walk(opts.projectsDir, files);

  const cursors: Cursors = {};
  const all: UsageEvent[] = [];
  let filesRead = 0;

  for (const file of files) {
    const old = opts.cursors[file];
    try {
      const st = await stat(file);
      if (!old && st.mtimeMs < opts.since) {
        cursors[file] = { offset: st.size, size: st.size, mtimeMs: st.mtimeMs };
        continue;
      }
      let start = old ? old.offset : 0;
      if (old && st.size < old.offset) start = 0;
      if (old && st.size === old.offset && start === old.offset) {
        cursors[file] = { offset: old.offset, size: st.size, mtimeMs: st.mtimeMs };
        continue;
      }
      const { events, offset } = await readRange(file, start, st.size, opts.deviceId, chunkSize);
      filesRead++;
      for (const e of events) if (e.ts >= opts.since) all.push(e);
      cursors[file] = { offset, size: st.size, mtimeMs: st.mtimeMs };
    } catch (e: any) {
      console.warn(`[deskbuddy-cc] cannot scan ${file}: ${e?.code ?? e?.message ?? e}`);
      if (old) cursors[file] = old;
    }
  }

  return { events: mergeEvents([], all), cursors, filesRead };
}
