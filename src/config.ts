import { z } from "zod";

/** Every environment variable the backend reads, in one place. Documented in .env.example. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // "offline" is a mechanical stand-in for local development and interface tests. It is refused in production.
  LLM_PROVIDER: z.enum(["gemini", "groq", "offline"]).default("gemini"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  // Defaults sit under the measured free-tier limits (15 requests/min, 250K tokens/min) to leave headroom.
  GEMINI_RPM: z.coerce.number().int().positive().default(12),
  GEMINI_TPM: z.coerce.number().int().positive().default(200_000),
  GROQ_API_KEY: z.string().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  // Groq's free tier: 30 requests/min but only 8K tokens/min, which is what actually binds.
  GROQ_RPM: z.coerce.number().int().positive().default(25),
  GROQ_TPM: z.coerce.number().int().positive().default(7_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_REPLAY_CACHE: z.string().default(""),
  ALLOW_PRIVATE_URLS: z.enum(["true", "false", ""]).default(""),
  // HTTP API
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGODB_DB: z.string().default("interview_prep_kit"),
  // Signs session tokens. The development default is refused in production (see loadConfig).
  JWT_SECRET: z.string().default("development-only-secret-change-me"),
  SESSION_DAYS: z.coerce.number().int().positive().default(7),
  // Register and sign-in attempts allowed per address per 15 minutes.
  AUTH_ATTEMPTS_PER_WINDOW: z.coerce.number().int().positive().default(30),
  // The browser origin allowed to call the API with credentials. The Next.js app proxies /api, so this is its own origin.
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  // Batch command: how many cases run at once, and how long one case may take before it is recorded as timed out.
  BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  CASE_TIMEOUT_MS: z.coerce.number().int().positive().default(170_000),
});

export type Config = z.infer<typeof EnvSchema>;

const DEVELOPMENT_SECRET = "development-only-secret-change-me";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = EnvSchema.parse(env);
  if (config.NODE_ENV === "production" && (config.JWT_SECRET === DEVELOPMENT_SECRET || config.JWT_SECRET.length < 32)) {
    throw new Error("JWT_SECRET must be set to a random value of at least 32 characters in production.");
  }
  if (config.NODE_ENV === "production" && config.LLM_PROVIDER === "offline") {
    throw new Error("LLM_PROVIDER=offline is for local development and tests only.");
  }
  return config;
}

/**
 * Whether company URLs may point at loopback or private addresses. Refused in
 * production, where the server fetches on behalf of strangers; allowed
 * elsewhere so that a company site served from localhost can be crawled.
 */
export function allowsPrivateUrls(config: Config): boolean {
  if (config.ALLOW_PRIVATE_URLS !== "") return config.ALLOW_PRIVATE_URLS === "true";
  return config.NODE_ENV !== "production";
}

/** Reads .env into process.env when the file exists. Real environment variables win. */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment, as on a deployed host.
  }
}
