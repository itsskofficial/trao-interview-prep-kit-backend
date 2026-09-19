# AI Interview Prep Kit - backend

Turns a job description, a company website and a number of days into a structured interview preparation kit. This repository holds the research and generation pipeline, the HTTP API and the batch command. The interface lives in [trao-interview-prep-kit-frontend](https://github.com/itsskofficial/trao-interview-prep-kit-frontend).

> Work in progress. This README is completed in the final ticket; the batch command below already works.

## Batch command

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env        # then set GEMINI_API_KEY (free key from https://aistudio.google.com)
npm run evaluate -- --input examples/cases.json --output kits.json
```

One entry is written per input case. A case that cannot produce a kit is recorded as `failed` with a code and the run continues.

## Tests

```bash
npm test
npm run typecheck
```

See [DECISIONS.md](DECISIONS.md) for the reasoning behind each design choice.
