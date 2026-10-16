import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const p = (...s) => join(root, ...s);
mkdirSync(p("dist"), { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: "info", target: "es2022" };

await build({ ...common, entryPoints: [p("src/server/main.ts")], outfile: p("dist/server.cjs"), platform: "node", format: "cjs", target: "node22" });

const rendererEntry = p("src/renderer/renderer.ts");
if (existsSync(rendererEntry)) {
  await build({ ...common, entryPoints: [rendererEntry], outfile: p("dist/renderer.js"), platform: "browser", format: "iife" });
} else {
  console.warn("[build] src/renderer/renderer.ts missing - skipping renderer bundle");
}

const rdir = p("src/renderer");
if (existsSync(rdir)) {
  for (const f of readdirSync(rdir)) {
    if (f === "index.html" || f.endsWith(".css")) copyFileSync(join(rdir, f), p("dist", f));
  }
}
if (!existsSync(p("src/renderer/index.html"))) console.warn("[build] src/renderer/index.html missing - skipping");

// Window icon
const icon = p("../src/icons/icon32.png");
if (existsSync(icon)) copyFileSync(icon, p("dist/icon.png"));
else console.warn("[build] ../src/icons/icon32.png missing");
console.log("[build] done");
