// Runs before every test file. Env is validated at import time in
// src/config/env.ts, so it has to be populated before any src module loads.
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
process.env["SERVICE_NAME"] = "api-gateway-test";
process.env["PORT"] ??= "4000";
// Short enough that the upstream-timeout test does not stall the suite.
process.env["PROXY_TIMEOUT_MS"] ??= "1000";
process.env["HEALTH_TIMEOUT_MS"] ??= "500";
// Must be at least 32 characters to satisfy the schema; the value only has to
// agree with whatever the tests sign their own tokens with.
process.env["JWT_SECRET"] ??= "test-jwt-secret-at-least-32-characters-long";
process.env["JWT_ISSUER"] ??= "auth-service";
process.env["JWT_AUDIENCE"] ??= "practical-microservice";
