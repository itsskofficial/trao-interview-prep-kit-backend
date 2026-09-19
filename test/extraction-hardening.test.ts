import { describe, expect, it } from "vitest";
import { containsPhrase, isQuotedFrom, normalise } from "../src/extraction/evidence";
import { decidePriority } from "../src/extraction/priority";

/** Cases a code review found by trying postings the way people actually write them. */

describe("evidence in postings with markup", () => {
  const posting = [
    "## What you bring",
    "- 5+ years with **React**, TypeScript and Node.js",
    "- You know `kubectl` and can debug a cluster",
    "- Experience with [GraphQL](https://graphql.org) APIs",
    "- CI/CD, observability… the usual",
    "- Comfortable with zero​width characters pasted from a PDF",
  ].join("\n");

  it.each([
    "5+ years with React, TypeScript and Node.js",
    "You know kubectl and can debug a cluster",
    "Experience with GraphQL APIs",
    "CI/CD, observability... the usual",
    "Comfortable with zerowidth characters pasted from a PDF",
  ])("verifies the plain-text quote %j", (quote) => {
    expect(isQuotedFrom(posting, quote)).toBe(true);
  });

  it("still refuses a quote that is not there", () => {
    expect(isQuotedFrom(posting, "5+ years with Angular, TypeScript and Node.js")).toBe(false);
    expect(isQuotedFrom(posting, "AWS Certified Solutions Architect")).toBe(false);
  });

  it("falls back to letters and digits for a long quote whose punctuation differs", () => {
    expect(isQuotedFrom("Strong SQL / PostgreSQL experience (5+ yrs)", "Strong SQL/PostgreSQL experience, 5+ yrs")).toBe(true);
  });
});

describe("short evidence is matched as whole words", () => {
  it("does not find Go inside good, or Java inside JavaScript", () => {
    expect(isQuotedFrom("We are a good team writing JavaScript.", "Go")).toBe(false);
    expect(isQuotedFrom("We are a good team writing JavaScript.", "Java")).toBe(false);
    expect(containsPhrase(normalise("Skills: Go, C++, C# and .NET"), "go")).toBe(true);
    expect(containsPhrase(normalise("Skills: Go, C++, C# and .NET"), "c++")).toBe(true);
    expect(containsPhrase(normalise("Skills: Go, C++, C# and .NET"), "c")).toBe(false);
  });

  it("decides priority from the line the evidence is really on", () => {
    const posting = "You must be good at working with people.\n\nNice to have:\n- Go\n- Rust";
    expect(decidePriority(posting, "Go", "must")).toBe("nice");
  });

  it("prefers the list item that is exactly the evidence over a sentence that mentions it", () => {
    const posting = "We use Python and must ship daily.\n\nNice to have\n- Python\n\nRequirements\n- SQL";
    expect(decidePriority(posting, "Python", "must")).toBe("nice");
  });
});

describe("priority when the wording is mixed or unusual", () => {
  const under = (heading: string, line: string) => `${heading}\n- ${line}`;

  it.each([
    ["Minimum of a Bachelor's degree, Master's preferred", "must"],
    ["Excellent communication skills (required), ideally in a remote-first team", "must"],
    ["A work permit is not required", "nice"],
    ["Experience with Rust is a big plus", "nice"],
    ["Kubernetes would be a strong plus", "nice"],
    ["Terraform is a plus", "nice"],
    ["Pluses: Kafka, Flink", "nice"],
  ] as const)("reads %j as %s even under a Requirements heading", (line, expected) => {
    expect(decidePriority(under("Requirements", line), line, expected === "must" ? "nice" : "must")).toBe(expected);
  });

  it("does not read a conjunction as a bonus", () => {
    const line = "Python plus SQL, every day";
    expect(decidePriority(under("Requirements", line), line, "nice")).toBe("must");
  });

  it("does not find 'desired' inside another word", () => {
    const line = "Handles undesired side effects calmly";
    expect(decidePriority(under("Requirements", line), line, "nice")).toBe("must");
  });

  it.each([
    ["Preferred qualifications", "nice"],
    ["Required qualifications", "must"],
    ["Minimum qualifications", "must"],
    ["Bonus points", "nice"],
    ["What we're looking for", "must"],
  ] as const)("reads the heading %j as %s", (heading, expected) => {
    expect(decidePriority(under(heading, "Elixir"), "Elixir", expected === "must" ? "nice" : "must")).toBe(expected);
  });
});
