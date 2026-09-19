import { z } from "zod";

/** Every environment variable the backend reads, in one place. Documented in .env.example. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LLM_PROVIDER: z.enum(["gemini", "groq"]).default("gemini"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  // Defaults sit under the measured free-tier limits (15 requests/min, 250K tokens/min) to leave headroom.
  GEMINI_RPM: z.coerce.number().int().positive().default(12),
  GEMINI_TPM: z.coerce.number().int().positive().default(200_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_REPLAY_CACHE: z.string().default(""),
  ALLOW_PRIVATE_URLS: z.enum(["true", "false", ""]).default(""),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
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
