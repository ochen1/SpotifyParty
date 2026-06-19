import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "clients/**/*.test.ts"],
    environment: "node"
  }
});
