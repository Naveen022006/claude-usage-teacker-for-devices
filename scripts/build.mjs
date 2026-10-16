import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const release = process.argv.includes("--release");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = { bundle: true, target: "chrome120", sourcemap: !release, minify: release, logLevel: "info" };

const builds = [
  // Content scripts must be classic scripts (no ESM), so IIFE.
  { ...common, entryPoints: { inject: "src/capture/inject.ts", bridge: "src/bridge.ts", widget: "src/widget/widget.ts" }, format: "iife", outdir: "dist" },
  { ...common, entryPoints: { sw: "src/sw.ts" }, format: "esm", outdir: "dist" },
  { ...common, entryPoints: { popup: "src/popup/popup.ts", options: "src/options/options.ts" }, format: "iife", outdir: "dist" },
];

const copyStatic = () => {
  for (const [from, to] of [
    ["src/manifest.json", "dist/manifest.json"],
    ["src/popup/popup.html", "dist/popup.html"],
    ["src/popup/popup.css", "dist/popup.css"],
    ["src/options/options.html", "dist/options.html"],
    ["src/options/options.css", "dist/options.css"],
  ]) cpSync(from, to);
  cpSync("src/icons", "dist/icons", { recursive: true });
  if (!release) cpSync("tools/widget-preview.html", "dist/widget-preview.html");
};

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  copyStatic();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStatic();
}
