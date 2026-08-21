import { readFile } from "node:fs/promises";
import esbuild from "esbuild";
import builtin from "builtin-modules";

const production = process.argv[2] === "production";

const external = ["obsidian", "electron", ...builtin];

// pdf.js needs its worker script served from a URL it can spin up a Worker
// from. There's no vendor/ directory to point at anymore (epub.js and
// pdf.js are now real bundled dependencies — see src/reader/epub/adapter.ts
// and src/reader/pdf/adapter.ts), so the worker's minified source is
// inlined into main.js as a string; the adapter turns it into a same-origin
// blob: URL at runtime instead. This plugin is scoped to that one exact
// file — pdfjs-dist's *other* .mjs files (including its main entry point,
// which the pdf adapter imports normally) must still load as real modules.
const pdfWorkerAsText = {
  name: "pdf-worker-as-text",
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist[/\\]build[/\\]pdf\.worker\.min\.mjs$/ }, async (args) => {
      const contents = await readFile(args.path, "utf8");
      return { contents, loader: "text" };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  plugins: [pdfWorkerAsText],
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
