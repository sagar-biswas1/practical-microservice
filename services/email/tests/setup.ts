// Runs before every test file. Env is validated at import time in
// src/config/env.ts, so it has to be populated before any src module loads.
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
process.env["SERVICE_NAME"] = "email-service-test";
process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/test?schema=email";
process.env["PORT"] ??= "4004";
// Tests inject their own provider; the default must not need credentials.
process.env["EMAIL_PROVIDER"] ??= "console";
