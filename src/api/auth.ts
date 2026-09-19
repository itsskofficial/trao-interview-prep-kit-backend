import bcrypt from "bcryptjs";
import { Router, type CookieOptions, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Config } from "../config";
import type { Database, UserDoc } from "../persistence/mongo";
import { ApiError, parse } from "./errors";

const COOKIE = "session";
const BCRYPT_ROUNDS = 12;
/** Compared against when an email is not registered, so a sign-in takes the same time either way. */
const DUMMY_HASH = bcrypt.hashSync("no-such-user", BCRYPT_ROUNDS);

const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254)),
  // bcrypt ignores everything past 72 bytes, so longer passwords are refused rather than silently truncated.
  password: z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters."),
});

const publicUser = (user: UserDoc) => ({ id: user._id.toHexString(), email: user.email });

function cookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true, // not readable by scripts, so a cross-site scripting bug cannot steal the session
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: "/",
    maxAge: config.SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

function startSession(response: Response, user: UserDoc, config: Config): void {
  const token = jwt.sign({ sub: user._id.toHexString() }, config.JWT_SECRET, { expiresIn: `${config.SESSION_DAYS}d` });
  response.cookie(COOKIE, token, cookieOptions(config));
}

/** Puts the signed-in user's id in `response.locals.userId`, or answers 401 saying whether the session expired or never existed. */
export function requireAuth(config: Config): RequestHandler {
  return (request, response, next) => {
    const token: unknown = request.cookies?.[COOKIE];
    if (typeof token !== "string" || token.length === 0) {
      return next(new ApiError(401, "UNAUTHENTICATED", "Sign in to continue."));
    }
    try {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
      const subject = typeof payload === "object" ? payload.sub : undefined;
      if (!subject || !ObjectId.isValid(subject)) throw new Error("no subject");
      response.locals.userId = new ObjectId(subject);
      next();
    } catch (error) {
      response.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
      const expired = error instanceof jwt.TokenExpiredError;
      next(new ApiError(401, expired ? "SESSION_EXPIRED" : "UNAUTHENTICATED", expired ? "Your session has expired. Sign in again." : "Sign in to continue."));
    }
  };
}

export function authRouter(db: Database, config: Config): Router {
  const router = Router();
  // Hashing is deliberately slow; tests do not need that.
  const rounds = config.NODE_ENV === "test" ? 4 : BCRYPT_ROUNDS;

  // Slows password guessing. Off in tests, which sign in many times from one address.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_ATTEMPTS_PER_WINDOW,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config.NODE_ENV === "test",
    handler: (_request, _response, next) => next(new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again in a few minutes.")),
  });

  router.post("/register", limiter, async (request, response) => {
    const { email, password } = parse(CredentialsSchema, request.body);
    const user: UserDoc = { _id: new ObjectId(), email, passwordHash: await bcrypt.hash(password, rounds), createdAt: new Date() };
    try {
      await db.users.insertOne(user);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.", [{ field: "email", message: "Already registered." }]);
      }
      throw error;
    }
    startSession(response, user, config);
    response.status(201).json({ user: publicUser(user) });
  });

  router.post("/login", limiter, async (request, response) => {
    const { email, password } = parse(CredentialsSchema.extend({ password: z.string().min(1, "Enter your password.").max(72) }), request.body);
    const user = await db.users.findOne({ email });
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");

    startSession(response, user, config);
    response.json({ user: publicUser(user) });
  });

  router.post("/logout", (_request, response) => {
    response.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
    response.status(204).end();
  });

  router.get("/me", requireAuth(config), async (_request, response) => {
    const user = await db.users.findOne({ _id: response.locals.userId as ObjectId });
    if (!user) {
      // A valid token for an account that no longer exists. Clear it, or the interface's route guard,
      // which only sees that a cookie is present, would keep sending the visitor back into the app.
      response.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    response.json({ user: publicUser(user) });
  });

  return router;
}
