import type { Kit } from "../../src/kit/schema";

/** A minimal kit using only the Appendix A fields, with no extensions. */
export function appendixAKit(): Kit {
  return {
    source: {
      company: "Acme",
      company_url: "http://localhost:8099/acme/",
      role: "Senior Backend Engineer",
      location: "Remote",
      jd_chars: 1200,
      researched_at: "2026-09-01T09:12:44Z",
      pages_used: ["http://localhost:8099/acme/"],
    },
    company_brief: {
      summary: "Acme builds logistics software.",
      what_they_do: "Route planning for couriers.",
      sources: ["http://localhost:8099/acme/"],
    },
    role: {
      title: "Senior Backend Engineer",
      seniority: "senior",
      responsibilities: ["Own the routing service"],
      requirements: [
        { id: "r1", text: "5+ years with Node.js", kind: "technical", priority: "must" },
        { id: "r2", text: "Mentoring junior engineers", kind: "behavioural", priority: "nice" },
      ],
    },
    questions: [
      {
        id: "q1",
        requirement_ids: ["r1"],
        category: "technical",
        prompt: "How does the Node.js event loop schedule work?",
        answer_outline: "Phases, microtasks, blocking.",
        difficulty: 2,
      },
      {
        id: "q2",
        requirement_ids: ["r2"],
        category: "behavioural",
        prompt: "Tell me about a time you mentored someone.",
        answer_outline: "Situation, action, result.",
        difficulty: 1,
      },
    ],
    flashcards: [{ id: "f1", front: "What is a microtask?", back: "A promise callback.", requirement_ids: ["r1"] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: "Node.js fundamentals", question_ids: ["q1"], minutes: 60 },
        { day: 2, focus: "Behavioural", question_ids: ["q2"], minutes: 30 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}
