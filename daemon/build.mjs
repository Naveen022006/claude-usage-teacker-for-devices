import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

rmSync("daemon/dist", { recursive: true, force: true });
await esbuild.build({
  entryPoints: ["daemon/src/cli.ts"],
  outfile: "daemon/dist/claude-usage-daemon.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
