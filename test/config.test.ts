import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseTimeoutMs, loadConfig } from "../src/config";

/** .env.example as a user's .env would be after "cp .env.example .env": every line KEY=value, many of them blank. */
function envExample(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(".env.example", "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe("configuration", () => {
  it("loads from an untouched copy of .env.example, the way the README tells people to start", () => {
    const config = loadConfig(envExample());
    expect(config.LLM_PROVIDER).toBe("gemini");
    expect(caseTimeoutMs(config)).toBe(170_000);
  });

  it("documents every variable it reads", () => {
    const documented = new Set(Object.keys(envExample()));
    const read = Object.keys(loadConfig({}));
    expect(read.filter((name) => !documented.has(name))).toEqual([]);
  });

  it("treats a blank variable as not set", () => {
    expect(loadConfig({ GEMINI_RPM: "", PORT: "  " })).toMatchObject({ GEMINI_RPM: 12, PORT: 4000 });
  });

  it("gives Groq cases longer, because its free tier is far slower", () => {
    expect(caseTimeoutMs(loadConfig({ LLM_PROVIDER: "groq" }))).toBe(600_000);
    expect(caseTimeoutMs(loadConfig({ LLM_PROVIDER: "groq", CASE_TIMEOUT_MS: "90000" }))).toBe(90_000);
  });

  it("refuses to start in production with a weak session secret or the offline model", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: "x".repeat(40), LLM_PROVIDER: "offline" })).toThrow(/offline/);
  });
});
