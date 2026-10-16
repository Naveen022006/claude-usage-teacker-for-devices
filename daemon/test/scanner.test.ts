import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scanner";
import { asst } from "./fixtures";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dbcc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = (since = 0) => ({ projectsDir: dir, deviceId: "dev", since });

describe("scan", () => {
  it("missing dir yields empty result", async () => {
    const r = await scan({ ...base(), projectsDir: join(dir, "nope"), cursors: {} });
    expect(r).toEqual({ events: [], cursors: {}, filesRead: 0 });
  });

  it("finds nested subagent files and dedupes across files/lines", async () => {
    await mkdir(join(dir, "proj", "sess", "subagents"), { recursive: true });
    const main = join(dir, "proj", "sess.jsonl");
    const sub = join(dir, "proj", "sess", "subagents", "agent-1.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: 'say "assistant"' } }),
      asst("m1", 5),
      asst("m1", 5),
      asst("m1", 9),
      asst("syn", 0, {}, "<synthetic>"),
      "{garbage",
    ];
    await writeFile(main, lines.join("\n") + "\n");
    await writeFile(sub, asst("m2", 7) + "\n" + asst("m1", 9) + "\n");
    const r = await scan({ ...base(), cursors: {} });
    expect(r.filesRead).toBe(2);
    expect(r.events.map((e) => e.id).sort()).toEqual(["m1", "m2"]);
    expect(r.events.find((e) => e.id === "m1")!.outputTokens).toBe(9);
    expect(Object.keys(r.cursors)).toHaveLength(2);
  });

  it("incremental: partial line then completion counted once", async () => {
    const f = join(dir, "s.jsonl");
    const l1 = asst("a", 1) + "\n";
    const l2 = asst("b", 2);
    await writeFile(f, l1 + l2.slice(0, 40));
    const r1 = await scan({ ...base(), cursors: {} });
    expect(r1.events.map((e) => e.id)).toEqual(["a"]);
    expect(r1.cursors[f].offset).toBe(Buffer.byteLength(l1));
    await appendFile(f, l2.slice(40) + "\n");
    const r2 = await scan({ ...base(), cursors: r1.cursors });
    expect(r2.events.map((e) => e.id)).toEqual(["b"]);
    const r3 = await scan({ ...base(), cursors: r2.cursors });
    expect(r3.events).toEqual([]);
    expect(r3.filesRead).toBe(0);
  });

  it("truncated file is reread from 0", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(f, asst("a", 1) + "\n" + asst("b", 2) + "\n");
    const r1 = await scan({ ...base(), cursors: {} });
    await writeFile(f, asst("c", 3) + "\n");
    const r2 = await scan({ ...base(), cursors: r1.cursors });
    expect(r2.events.map((e) => e.id)).toEqual(["c"]);
  });

  it("old file without cursor is skipped with cursor at end", async () => {
    const f = join(dir, "old.jsonl");
    const content = asst("a", 1) + "\n";
    await writeFile(f, content);
    const old = new Date(Date.now() - 10 * 86400_000);
    await utimes(f, old, old);
    const r = await scan({ ...base(Date.now() - 86400_000), cursors: {} });
    expect(r.events).toEqual([]);
    expect(r.filesRead).toBe(0);
    expect(r.cursors[f].offset).toBe(Buffer.byteLength(content));
  });

  it("drops cursors of deleted files", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(f, asst("a", 1) + "\n");
    const r1 = await scan({ ...base(), cursors: {} });
    await unlink(f);
    const r2 = await scan({ ...base(), cursors: r1.cursors });
    expect(r2.cursors).toEqual({});
  });

  it("handles multibyte chars split across tiny chunks", async () => {
    const f = join(dir, "s.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T10:00:00Z",
      message: { id: "mb", model: "mé中\u{1F600}", usage: { output_tokens: 4 } },
    });
    await writeFile(f, line + "\n" + line + "\n");
    const r = await scan({ ...base(), cursors: {} }, 7);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].model).toBe("mé中\u{1F600}");
    expect(r.cursors[f].offset).toBe(Buffer.byteLength(line + "\n" + line + "\n"));
  });
});

describe.skipIf(process.env.CLAUDE_USAGE_REAL !== "1")("real data smoke", () => {
  it("scans ~/.claude/projects", async () => {
    const r = await scan({ projectsDir: join(homedir(), ".claude", "projects"), cursors: {}, deviceId: "smoke", since: Date.now() - 86400_000 });
    const ids = new Set(r.events.map((e) => e.id));
    const models = [...new Set(r.events.map((e) => e.model))];
    const out = r.events.reduce((s, e) => s + e.outputTokens, 0);
    console.log(`REAL events=${r.events.length} files=${Object.keys(r.cursors).length} read=${r.filesRead} models=${models.join(",")} outputTokens=${out}`);
    expect(r.events.length).toBeGreaterThan(0);
    expect(ids.size).toBe(r.events.length);
  });
});
