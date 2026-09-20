import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger } from "pino";

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Nothing in the application logs a request body, a header or a document, so none of these should
 * ever be reached. They are censored anyway: the day someone logs an object without thinking is the
 * day a password ends up in a log viewer.
 */
const SECRET = /^(password|passwordhash|cookie|set-cookie|authorization|token|accesstoken|refreshtoken|apikey|api_key|secret|jwt|session)$/i;
const MAX_DEPTH = 8;

/** Censors secret-named keys however deep they sit. Path lists only reach as far as someone thought to write them. */
export function censor(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  // Errors keep their own serialiser; dates and buffers have nothing to censor.
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return "[omitted]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => censor(entry, depth + 1, seen));
  // An ObjectId and the like: something with its own idea of how to be written.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET.test(key) ? "[redacted]" : censor(entry, depth + 1, seen)]));
}

/** JSON lines on stdout: what a host's log viewer can filter by job, request or user. */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: undefined, // pid and hostname say nothing on a single container
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }), log: (fields) => censor(fields) as Record<string, unknown> },
    },
    destination,
  );
}

export const silentLogger: Logger = pino({ level: "silent" });

const REQUEST_ID = /^[\w.-]{8,64}$/;

/**
 * One line per request, written when the response ends: id, method, path, status, how long it took
 * and who asked. Never the query string, a header or the body. The id goes back in `X-Request-Id`,
 * so a user reporting a failure can say which one.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const offered = request.get("x-request-id");
    // Accepted from a proxy in front of us if it is plainly an id, never as free text to write into the log.
    const requestId = offered && REQUEST_ID.test(offered) ? offered : randomUUID();
    const startedAt = process.hrtime.bigint();
    // Read now: once a router has taken the request, its path is relative to where that router is mounted.
    const { path } = request;
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);

    response.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const userId = response.locals.userId as { toHexString?: () => string } | undefined;
      const line = { requestId, method: request.method, path, status: response.statusCode, ms, ...(userId?.toHexString ? { userId: userId.toHexString() } : {}) };
      // The keep-warm ping arrives every few minutes for ever; it is not worth a line at the normal level.
      if (path === "/api/health") logger.debug(line, "request");
      else if (response.statusCode >= 500) logger.error(line, "request");
      else logger.info(line, "request");
    });
    next();
  };
}
