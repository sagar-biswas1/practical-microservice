// Runs before every test file. Env is validated at import time in
// src/config/env.ts, so it has to be populated before any src module loads.
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
process.env["SERVICE_NAME"] = "api-gateway-test";
process.env["PORT"] ??= "4000";
// Short enough that the upstream-timeout test does not stall the suite.
process.env["PROXY_TIMEOUT_MS"] ??= "1000";
process.env["HEALTH_TIMEOUT_MS"] ??= "500";
