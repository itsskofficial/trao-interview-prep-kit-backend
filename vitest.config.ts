import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Entry points: they wire things together and start listening, which the tests do through the parts instead.
      exclude: ["src/server.ts", "src/cli/**"],
      reporter: ["text-summary"],
      // A floor a little under where coverage stood when it was first measured (88 / 81 / 88 / 90), so that it can only
      // be lowered on purpose. Not a target: a test is written because a behaviour matters, not to move a number.
      thresholds: { statements: 85, branches: 78, functions: 85, lines: 87 },
    },
  },
});
