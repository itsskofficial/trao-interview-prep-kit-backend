import { describe, expect, it } from "vitest";
import { BatchOutputSchema, CaseInputSchema } from "../src/batch/schema";
import { appendixAKit } from "./support/kits";

describe("batch input", () => {
  const validCase = { id: "case-01", jd: "Senior Backend Engineer", company_url: "http://localhost:8099/acme/", days: 5 };

  it("accepts the Appendix B case shape", () => {
    expect(CaseInputSchema.safeParse(validCase).success).toBe(true);
  });

  it("accepts an empty description so the pipeline can report it as a failed case", () => {
    expect(CaseInputSchema.safeParse({ ...validCase, jd: "" }).success).toBe(true);
  });

  it.each([0, -1, 2.5, "five", "", 366])("rejects days = %s", (days) => {
    expect(CaseInputSchema.safeParse({ ...validCase, days }).success).toBe(false);
  });

  it("rejects a case without an id", () => {
    expect(CaseInputSchema.safeParse({ ...validCase, id: undefined }).success).toBe(false);
  });
});

describe("batch output", () => {
  const failed = {
    id: "case-04",
    status: "failed",
    kit: null,
    error: { code: "LLM_UNAVAILABLE", message: "Model unavailable after retries." },
  };

  it("accepts ok and failed entries side by side", () => {
    const output = {
      version: "1.0",
      generated_at: "2026-09-01T09:12:44Z",
      kits: [{ id: "case-01", status: "ok", kit: appendixAKit(), error: null }, failed],
    };
    expect(BatchOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects an ok entry without a kit", () => {
    const output = { version: "1.0", generated_at: "now", kits: [{ id: "c", status: "ok", kit: null, error: null }] };
    expect(BatchOutputSchema.safeParse(output).success).toBe(false);
  });

  it("rejects a failed entry without an error", () => {
    const output = { version: "1.0", generated_at: "now", kits: [{ ...failed, error: null }] };
    expect(BatchOutputSchema.safeParse(output).success).toBe(false);
  });
});
