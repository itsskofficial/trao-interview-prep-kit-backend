import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { kitRepository } from "../src/persistence/kits";
import { startTestApi, type TestApi } from "./support/api";
import { appendixAKit } from "./support/kits";

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
}, 120_000);
afterAll(() => api.close());
beforeEach(() => api.reset());

const credentials = { email: "Ada@Example.com ", password: "correct horse battery" };

describe("registration and sign-in", () => {
  it("registers, signs the user in with an httpOnly cookie, and never returns the password hash", async () => {
    const response = await request(api.app).post("/api/auth/register").send(credentials).expect(201);
    expect(response.body).toEqual({ user: { id: expect.any(String), email: "ada@example.com" } });

    const cookie = response.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await api.db.users.findOne({}))!.passwordHash).not.toContain("correct horse");
  });

  it("names each invalid field", async () => {
    const response = await request(api.app).post("/api/auth/register").send({ email: "nope", password: "short" }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
    expect(response.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(["email", "password"]);
  });

  it("refuses a second account with the same email, whatever its letter case", async () => {
    await request(api.app).post("/api/auth/register").send(credentials).expect(201);
    const response = await request(api.app).post("/api/auth/register").send({ ...credentials, email: "ADA@example.com" }).expect(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("signs in with the right password and gives the same answer for a wrong password and an unknown email", async () => {
    await request(api.app).post("/api/auth/register").send(credentials).expect(201);
    await request(api.app).post("/api/auth/login").send(credentials).expect(200);

    const wrong = await request(api.app).post("/api/auth/login").send({ ...credentials, password: "wrong password!" }).expect(401);
    const unknown = await request(api.app).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever123" }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("signs out by clearing the cookie", async () => {
    const agent = await api.signedIn();
    await agent.get("/api/auth/me").expect(200);
    await agent.post("/api/auth/logout").expect(204);
    await agent.get("/api/auth/me").expect(401);
  });
});

describe("sessions", () => {
  it("answers 401 UNAUTHENTICATED on protected routes without a session", async () => {
    for (const path of ["/api/auth/me", "/api/kits", "/api/kits/abc"]) {
      const response = await request(api.app).get(path).expect(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("tells an expired session apart from a missing one", async () => {
    const expired = jwt.sign({ sub: new ObjectId().toHexString() }, api.config.JWT_SECRET, { expiresIn: -10 });
    const response = await request(api.app).get("/api/kits").set("Cookie", `session=${expired}`).expect(401);
    expect(response.body.error.code).toBe("SESSION_EXPIRED");
  });

  it.each([
    ["a token signed with another secret", () => jwt.sign({ sub: new ObjectId().toHexString() }, "some-other-secret-some-other-secret")],
    ["an unsigned token", () => jwt.sign({ sub: new ObjectId().toHexString() }, "", { algorithm: "none" })],
    ["garbage", () => "not-a-token"],
  ])("rejects %s", async (_label, token) => {
    const response = await request(api.app).get("/api/kits").set("Cookie", `session=${token()}`).expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a valid token whose user no longer exists", async () => {
    const agent = await api.signedIn();
    await api.db.users.deleteMany({});
    await agent.get("/api/auth/me").expect(401);
  });
});

describe("kit ownership", () => {
  it("lets a user list, read and delete only their own kits", async () => {
    const ada = await api.signedIn("ada@example.com");
    const bob = await api.signedIn("bob@example.com");
    const adaId = (await api.db.users.findOne({ email: "ada@example.com" }))!._id;
    const stored = await kitRepository(api.db).create(adaId, appendixAKit(), "fingerprint");

    expect((await ada.get("/api/kits").expect(200)).body.kits).toEqual([
      expect.objectContaining({ id: stored.id, company: "Acme", role: "Senior Backend Engineer", questionCount: 2, daysAvailable: 2 }),
    ]);
    expect((await ada.get(`/api/kits/${stored.id}`).expect(200)).body.kit.source.company).toBe("Acme");

    expect((await bob.get("/api/kits").expect(200)).body.kits).toEqual([]);
    expect((await bob.get(`/api/kits/${stored.id}`).expect(404)).body.error.code).toBe("NOT_FOUND");
    await bob.delete(`/api/kits/${stored.id}`).expect(404);

    await ada.delete(`/api/kits/${stored.id}`).expect(204);
    await ada.get(`/api/kits/${stored.id}`).expect(404);
  });

  it("answers 404, not 500, for an id that is not an id", async () => {
    const ada = await api.signedIn();
    await ada.get("/api/kits/not-an-object-id").expect(404);
  });
});

describe("errors", () => {
  it("uses the same error shape for unknown routes, malformed JSON and oversized bodies", async () => {
    const unknown = await request(api.app).get("/api/nope").expect(404);
    expect(unknown.body).toEqual({ error: { code: "NOT_FOUND", message: "No route for GET /api/nope." } });

    const malformed = await request(api.app).post("/api/auth/login").set("Content-Type", "application/json").send("{oops").expect(400);
    expect(malformed.body.error.code).toBe("MALFORMED_JSON");

    const huge = await request(api.app).post("/api/auth/login").send({ email: "a@b.co", password: "x".repeat(2_000_000) }).expect(413);
    expect(huge.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("reports health without a session", async () => {
    expect((await request(api.app).get("/api/health").expect(200)).body).toEqual({ status: "ok" });
  });
});
