import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Entry points: they wire things together and start listening, which the tests do through the parts instead.
      exclude: ["src/server.ts", "src/cli/**"],
      reporter: ["text-summary"],
      // A floor a little under where coverage stood when it was first measured with the entry points left out
      // (91 statements, 82 branches), so that it can only be lowered on purpose, and an unrelated change does not fail
      // for the sake of a decimal. Not a target: a test is written because a behaviour matters, not to move a number.
      thresholds: { statements: 88, branches: 80, functions: 88, lines: 90 },
    },
  },
});
