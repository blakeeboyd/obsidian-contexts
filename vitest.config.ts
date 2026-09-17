import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The obsidian npm package is types-only (no runtime entry); alias it to a
// stub so tests can import modules that import obsidian.
export default defineConfig({
  test: {
    alias: { obsidian: fileURLToPath(new URL("./src/obsidian-stub.ts", import.meta.url)) },
  },
});
