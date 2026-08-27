// Runs before every test file. Env is validated at import time in
// src/config/env.ts, so it has to be populated before any src module loads.
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
process.env["SERVICE_NAME"] = "auth-service-test";
process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/test?schema=auth";
process.env["PORT"] ??= "4005";

// A fixed key, so a signature produced in one test verifies in another. It is
// only ever used against the in-memory doubles.
process.env["JWT_SECRET"] ??= "test-secret-that-is-at-least-32-characters-long";

// Argon2 at production cost turns a suite with a few dozen logins in it into a
// minute of waiting. These are the lowest values the library accepts, which is
// the right trade here: the tests are asserting *policy* — lockouts, rotation,
// enumeration behaviour — and none of that depends on how expensive the hash
// is. `password.test.ts` is what checks that hashing and verification actually
// work.
process.env["ARGON2_MEMORY_COST_KIB"] ??= "8192";
process.env["ARGON2_TIME_COST"] ??= "2";
process.env["ARGON2_PARALLELISM"] ??= "1";
