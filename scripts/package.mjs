// Zero-dependency zip writer: zips dist/ contents into release/usage-meter-for-claude-<version>.zip
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

const table = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const walk = (dir, rel = "") =>
  readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n), r = posix.join(rel, n);
    return statSync(p).isDirectory() ? walk(p, r) : [{ path: p, name: r }];
  });

const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

export function makeZip(files) {
  const { time, date } = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = f.data, comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt16LE(time, 10); l.writeUInt16LE(date, 12); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    locals.push(l, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += l.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

export function listZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error("no end-of-central-directory record");
  const n = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nl), size: buf.readUInt32LE(p + 24) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

const { version } = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const files = walk("dist").map((f) => ({ name: f.name, data: readFileSync(f.path) }));
if (!files.some((f) => f.name === "manifest.json")) throw new Error("dist/manifest.json missing; run the build first");
mkdirSync("release", { recursive: true });
const out = `release/usage-meter-for-claude-${version}.zip`;
const zip = makeZip(files);
writeFileSync(out, zip);

const entries = listZip(readFileSync(out));
if (!entries.some((e) => e.name === "manifest.json")) throw new Error("manifest.json is not at zip root");
console.log(`${out} (${zip.length} bytes, ${entries.length} entries)`);
for (const e of entries) console.log(`  ${e.name} (${e.size})`);
