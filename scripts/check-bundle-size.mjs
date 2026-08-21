import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const MAIN_JS_LIMIT = 1 * 1024 * 1024; // 1MB
const TOTAL_LIMIT = 6 * 1024 * 1024; // 6MB

function fmt(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
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

const vendorSize = dirSize(join(repoRoot, "vendor"));
const totalSize = mainJsSize + vendorSize;

let failed = false;

if (mainJsSize >= MAIN_JS_LIMIT) {
  console.error(
    `check-bundle-size: main.js is ${fmt(mainJsSize)}, which exceeds the ${fmt(MAIN_JS_LIMIT)} limit.`,
  );
  failed = true;
}

if (totalSize >= TOTAL_LIMIT) {
  console.error(
    `check-bundle-size: main.js + vendor/ total ${fmt(totalSize)} (main.js: ${fmt(mainJsSize)}, vendor/: ${fmt(vendorSize)}), which exceeds the ${fmt(TOTAL_LIMIT)} limit.`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(
  `check-bundle-size: OK (main.js: ${fmt(mainJsSize)}, vendor/: ${fmt(vendorSize)}, total: ${fmt(totalSize)})`,
);
