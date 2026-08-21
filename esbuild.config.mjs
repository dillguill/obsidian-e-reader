import esbuild from "esbuild";
import builtin from "builtin-modules";

const production = process.argv[2] === "production";

// Anything under vendor/ is loaded lazily at runtime via dynamic import()
// (e.g. pdf.js / epub.js engines). Marking it external stops esbuild from
// inlining those chunks into main.js — the import() call is left intact
// so it still resolves lazily (as a require() under the hood, since we
// emit cjs) instead of being bundled eagerly.
const external = [
  "obsidian",
  "electron",
  ...builtin,
  "vendor/*",
  "./vendor/*",
  "../vendor/*",
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  splitting: false,
  treeShaking: true,
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
