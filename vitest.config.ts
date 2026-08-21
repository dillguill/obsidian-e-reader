import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/fakes/obsidian.ts"),
    },
  },
});
