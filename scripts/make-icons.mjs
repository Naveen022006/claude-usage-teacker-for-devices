// Generates src/icons/icon{16,32,48,128}.png using only Node built-ins.
// Mark: dark rounded square with a blue gauge arc and needle (original design).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BG = [0x1f, 0x1e, 0x1d];
const FG = [0x3b, 0x82, 0xf6];
const SS = 4; // supersampling per axis

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

// Coverage tests in unit coordinates (0..1).
const inRoundRect = (x, y) => {
  const r = 0.22, m = 0;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r);
  const cy = Math.min(Math.max(y, m + r), 1 - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const CX = 0.5, CY = 0.62, R = 0.3, W = 0.075;
const inArc = (x, y) => {
  const dx = x - CX, dy = y - CY;
  const d = Math.hypot(dx, dy);
  if (Math.abs(d - R) > W / 2) return false;
  return dy <= 0.0; // upper half: 180deg sweep
};
const NA = -Math.PI / 3;
const inNeedle = (x, y) => {
  const dx = x - CX, dy = y - CY;
  const ux = Math.cos(NA), uy = Math.sin(NA);
  const t = dx * ux + dy * uy;
  const p = Math.abs(-dx * uy + dy * ux);
  return t >= 0 && t <= R * 0.9 && p <= 0.035 * (1 - (t / (R * 0.9)) * 0.5);
};
const inHub = (x, y) => Math.hypot(x - CX, y - CY) <= 0.065;
const inEnd = (x, y) => [Math.PI, 0].some((a) => Math.hypot(x - (CX + R * Math.cos(a)), y - (CY + R * Math.sin(a))) <= W / 2);

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let a = 0, f = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
        if (!inRoundRect(x, y)) continue;
        a++;
        if (inArc(x, y) || inEnd(x, y) || inNeedle(x, y) || inHub(x, y)) f++;
      }
      const n = SS * SS, o = py * (size * 4 + 1) + 1 + px * 4;
      if (a === 0) continue;
      const t = f / a;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] + (FG[i] - BG[i]) * t);
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("src/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(`src/icons/icon${s}.png`, render(s));
  console.log(`wrote src/icons/icon${s}.png`);
}
