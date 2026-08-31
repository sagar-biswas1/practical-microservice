import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/lib/password.js";
import {
  createRefreshToken,
  extractBearerToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../../src/lib/tokens.js";
import { CODE_LENGTH, generateCode, hashCode } from "../../src/utils/codes.js";
import { safeEqual, sha256 } from "../../src/utils/hash.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const [hashError, digest] = await hashPassword("correct-horse-battery-staple");
    expect(hashError).toBeNull();

    const [, matched] = await verifyPassword(digest!, "correct-horse-battery-staple");
    expect(matched).toBe(true);

    const [, mismatched] = await verifyPassword(digest!, "Correct-horse-battery-staple");
    expect(mismatched).toBe(false);
  });

  it("produces a different digest each time for the same password", async () => {
    const [, first] = await hashPassword("correct-horse-battery-staple");
    const [, second] = await hashPassword("correct-horse-battery-staple");

    // Per-hash salt. Without it, identical passwords share a digest and one
    // precomputed table cracks every account that chose the same one.
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$argon2id\$/);
  });

  it("reports a corrupted digest as an error, not as a wrong password", async () => {
    const [error, matched] = await verifyPassword("not-a-valid-argon2-digest", "anything");

    // The distinction matters: collapsing these into `false` would make a
    // broken hash column look like a wave of failed logins instead of an
    // outage.
    expect(error).not.toBeNull();
    expect(matched).toBeNull();
  });

  it("keeps verifying a digest made with different cost parameters", async () => {
    // Produced with m=8, t=2, p=1 — far below the configured settings. The
    // parameters live in the digest, so raising the config must not lock
    // existing users out.
    const legacy =
      "$argon2id$v=19$m=8,t=2,p=1$c29tZXNhbHR2YWx1ZQ$MHzPQ3Yhs2sN7vNIvE2ZQNoq7nqQBiPJXJXQ8V5ZOZo";

    const [error] = await verifyPassword(legacy, "whatever");
    // Either it verifies or it does not — what must not happen is a thrown
    // "unsupported parameters" turning into a 500.
    expect(error).toBeNull();
  });
});

describe("access tokens", () => {
  const claims = {
    sub: "5f9b2c1e-0000-4000-8000-000000000001",
    email: "delivered@resend.dev",
    username: "ada",
    role: "USER",
    sid: "5f9b2c1e-0000-4000-8000-000000000002",
  };

  it("round-trips its claims", async () => {
    const [signError, token] = await signAccessToken(claims);
    expect(signError).toBeNull();

    const [verifyError, decoded] = await verifyAccessToken(token!.token);

    expect(verifyError).toBeNull();
    expect(decoded).toMatchObject(claims);
    expect(token!.expiresIn).toBeGreaterThan(0);
  });

  it("rejects a token whose payload was edited", async () => {
    const [, token] = await signAccessToken(claims);
    const [header, payload, signature] = token!.token.split(".");

    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    decoded["role"] = "ADMIN";
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");

    const [error] = await verifyAccessToken(`${header}.${forged}.${signature}`);

    // The signature is what makes the role claim trustworthy enough for
    // `requireRole` to act on without a database lookup.
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(401);
  });

  it("rejects an unsigned `alg: none` token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: claims.sub, role: "ADMIN", iss: "auth-service" }),
    ).toString("base64url");

    const [error] = await verifyAccessToken(`${header}.${payload}.`);

    // The classic JWT vulnerability. `algorithms: ["HS256"]` is what closes it:
    // the verifier decides the algorithm, never the token.
    expect(error).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [, token] = await signAccessToken(claims, anHourAgo);

    const [error] = await verifyAccessToken(token!.token);

    expect(error).not.toBeNull();
  });

  it("rejects a well-formed token from a different issuer", async () => {
    // Signed with the same secret but claiming another origin — e.g. a staging
    // environment that shares the key.
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"]);
    const foreign = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer("some-other-service")
      .setAudience("practical-microservice")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secret);

    const [error] = await verifyAccessToken(foreign);

    expect(error).not.toBeNull();
  });

  it("gives the same message for every kind of failure", async () => {
    const [expiredError] = await verifyAccessToken(
      (await signAccessToken(claims, new Date(Date.now() - 3_600_000)))[1]!.token,
    );
    const [garbageError] = await verifyAccessToken("not.a.token");

    // Telling a forger which part to fix next is free help.
    expect(expiredError?.message).toBe(garbageError?.message);
  });
});

describe("refresh tokens", () => {
  it("stores only a hash of the value it hands out", () => {
    const issued = createRefreshToken();

    expect(issued.tokenHash).toBe(hashRefreshToken(issued.token));
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.tokenHash).toHaveLength(64);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never issues the same token twice", () => {
    const values = new Set(Array.from({ length: 500 }, () => createRefreshToken().token));

    expect(values.size).toBe(500);
  });
});

describe("extractBearerToken", () => {
  it("accepts a well-formed header, case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("rejects anything else", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("")).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer  ")).toBeUndefined();
    // Two values is not a token with a space in it — it is a malformed header.
    expect(extractBearerToken("Bearer abc def")).toBeUndefined();
  });
});

describe("verification codes", () => {
  it("is always exactly six digits, leading zeros included", () => {
    for (let i = 0; i < 2_000; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it("uses the whole 10^6 space", () => {
    const codes = Array.from({ length: 5_000 }, generateCode);

    // Padding rather than starting at 100000: excluding leading zeros would
    // throw away a tenth of the space for cosmetics.
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(4_000);
  });

  it("hashes deterministically", () => {
    expect(hashCode("012345")).toBe(hashCode("012345"));
    expect(hashCode("012345")).not.toBe(hashCode("012346"));
    // 64 hex characters, matching the VarChar(64) column.
    expect(hashCode("0".repeat(CODE_LENGTH))).toHaveLength(64);
  });
});

describe("safeEqual", () => {
  it("matches identical strings and nothing else", () => {
    const digest = sha256("value");

    expect(safeEqual(digest, sha256("value"))).toBe(true);
    expect(safeEqual(digest, sha256("other"))).toBe(false);
  });

  it("returns false for different lengths instead of throwing", () => {
    // `timingSafeEqual` throws on a length mismatch; the guard is why this is
    // safe to call on untrusted input.
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});
