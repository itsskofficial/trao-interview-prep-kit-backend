import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, type z } from "zod";

/** Every error the API returns has this shape, so the interface can show something useful. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static notFound(what: string): ApiError {
    // Also returned for something that exists but belongs to someone else, so ids cannot be probed.
    return new ApiError(404, "NOT_FOUND", `${what} not found.`);
  }
}

/** Parses a request body or query against a schema, turning failures into a 400 that names each field. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, "VALIDATION_FAILED", "The request is not valid.", fieldIssues(result.error));
}

function fieldIssues(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({ field: issue.path.join(".") || "(body)", message: issue.message }));
}

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new ApiError(404, "NOT_FOUND", `No route for ${request.method} ${request.path}.`));
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ApiError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } };
    return void response.status(error.status).json(body);
  }
  // body-parser failures: malformed JSON or a body over the size limit
  const status = (error as { status?: number }).status;
  if (status === 400 || status === 413) {
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : "MALFORMED_JSON";
    return void response.status(status).json({ error: { code, message: status === 413 ? "The request body is too large." : "The request body is not valid JSON." } });
  }

  console.error(error);
  response.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on our side." } });
};
