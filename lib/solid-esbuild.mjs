// esbuild plugin: compile .jsx/.tsx with Solid 2's native
// compiler (@solidjs/compiler, generate "dom").
import fs from "node:fs";
import { createRequire } from "node:module";
const { transform } = createRequire(import.meta.url)("@solidjs/compiler");
export const solidPlugin = () => ({
  name: "solid",
  setup(b) {
    b.onLoad({ filter: /\.[jt]sx$/ }, (a) => ({
      contents: transform(fs.readFileSync(a.path, "utf8"), { filename: a.path, generate: "dom", hydratable: false }).code,
      loader: a.path.endsWith(".tsx") ? "ts" : "js",
    }));
  },
});
