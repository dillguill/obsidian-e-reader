import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// epub.js and pdf.js are now bundled straight into main.js (no more
// vendor/ dir loaded lazily at runtime) — this limit covers that.
const MAIN_JS_LIMIT = 6 * 1024 * 1024; // 6MB

function fmt(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

const mainJsPath = join(repoRoot, "main.js");
let mainJsSize;
try {
  mainJsSize = statSync(mainJsPath).size;
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(
      `check-bundle-size: expected build output at ${mainJsPath} but it does not exist. Run the build first.`,
    );
    process.exit(1);
  }
  throw err;
}

if (mainJsSize >= MAIN_JS_LIMIT) {
  console.error(
    `check-bundle-size: main.js is ${fmt(mainJsSize)}, which exceeds the ${fmt(MAIN_JS_LIMIT)} limit.`,
  );
  process.exit(1);
}

console.log(`check-bundle-size: OK (main.js: ${fmt(mainJsSize)})`);
