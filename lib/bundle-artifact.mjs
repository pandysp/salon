// bundleArtifact(dir, { label }) -> { manifest, files } ready for POST /api/artifacts/<name>/versions.
// <dir>/main.jsx (Solid 2, compiled locally with @solidjs/compiler) -> app.js; <dir>/style.css copied; <dir>/manifest.json;
// index.html generated: it loads the SDK from the content host (/_sdk/artifact-sdk.js) before the app.
// Seam for chunk 4: the pi bridge / MCP publish path compiles artifacts the same way.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { solidPlugin } from "./solid-esbuild.mjs";

// artifacts can live anywhere (pi's working folder): solid-js and friends resolve from this repo
const REPO_MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules");

// A <dir> that has its own index.html is a static bundle: every file except manifest.json is published as is.
export async function bundleArtifact(dir, { label = "v?" } = {}) {
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  if (fs.existsSync(path.join(dir, "index.html")))
    return { manifest, files: Object.fromEntries(fs.readdirSync(dir).filter((f) => f !== "manifest.json").map((f) => [f, read(f)])) };
  const js = await build({
    entryPoints: [path.join(dir, "main.jsx")], bundle: true, format: "esm", platform: "browser", minify: true, write: false,
    conditions: ["browser", "import"], logLevel: "error", plugins: [solidPlugin()], nodePaths: [REPO_MODULES], define: { __LABEL__: JSON.stringify(label) },
  });
  const files = {
    "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(manifest.title ?? "artifact")}</title>` +
      (fs.existsSync(path.join(dir, "style.css")) ? `<link rel="stylesheet" href="style.css">` : "") +
      `<script src="/_sdk/artifact-sdk.js"></script><script type="module" src="app.js"></script></head><body><div id="root"></div></body></html>`,
    "app.js": js.outputFiles[0].text,
  };
  if (fs.existsSync(path.join(dir, "style.css"))) files["style.css"] = read("style.css");
  return { manifest, files };
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
