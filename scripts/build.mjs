// Builds app/worker.js: the platform Worker with the shell bundle (Solid 2, compiled by @solidjs/compiler like the
// authoring-loop spike's build.mjs) and the artifact SDK inlined as strings.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { solidPlugin } from "../lib/solid-esbuild.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = await build({
  entryPoints: [path.join(root, "src/shell/main.jsx")], bundle: true, format: "esm", platform: "browser", minify: true,
  write: false, conditions: ["browser", "import"], logLevel: "error", plugins: [solidPlugin()],
});
await build({
  entryPoints: [path.join(root, "src/worker/index.ts")], bundle: true, format: "esm", platform: "neutral",
  conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"], external: ["cloudflare:workers"],
  outfile: path.join(root, "app/worker.js"), logLevel: "error",
  define: {
    __SHELL_JS__: JSON.stringify(shell.outputFiles[0].text),
    __SHELL_CSS__: JSON.stringify(fs.readFileSync(path.join(root, "src/shell/shell.css"), "utf8")),
    __SDK_JS__: JSON.stringify(fs.readFileSync(path.join(root, "src/sdk/artifact-sdk.js"), "utf8")),
  },
  banner: { js: "// Built by scripts/build.mjs; do not edit. Source: src/." },
});
console.log(`built app/worker.js (${(fs.statSync(path.join(root, "app/worker.js")).size / 1024).toFixed(0)} KB, shell ${(shell.outputFiles[0].text.length / 1024).toFixed(0)} KB)`);
