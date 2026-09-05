import assert from "node:assert/strict";

import { parseWorkerRuntimeConfig } from "../src/worker_config.ts";

assert.deepEqual(
  parseWorkerRuntimeConfig(`Run a long task.

Worker model: anthropic/claude-sonnet-4
Worker attempts: 4
Worker timeout: 45m
Max bash timeout: 120s`),
  {
    modelName: "anthropic/claude-sonnet-4",
    maxAttemptsPerTask: 4,
    taskTimeoutMs: 45 * 60 * 1000,
    maxBashTimeoutMs: 120 * 1000,
  },
);

assert.deepEqual(
  parseWorkerRuntimeConfig(
    "Use worker provider openai-codex and worker model gpt-5.5 with 2 attempts and a 1.5 hour timeout.",
  ),
  {
    modelName: "openai-codex/gpt-5.5",
    maxAttemptsPerTask: 2,
    taskTimeoutMs: 90 * 60 * 1000,
  },
);

assert.deepEqual(parseWorkerRuntimeConfig("Implement the feature normally."), {});

assert.deepEqual(
  parseWorkerRuntimeConfig(`Worker session reuse: disabled
Worker session reuse context threshold: 64%`),
  {
    workerSessionReuseEnabled: false,
    workerSessionReuseContextThresholdPercent: 64,
  },
);

assert.deepEqual(parseWorkerRuntimeConfig("Use session reuse context threshold: 0%"), {});
assert.deepEqual(parseWorkerRuntimeConfig("Use session reuse context threshold: 101%"), {});
assert.deepEqual(parseWorkerRuntimeConfig("Worker session reuse is on."), { workerSessionReuseEnabled: true });

assert.deepEqual(
  parseWorkerRuntimeConfig(`Network recovery: enabled
Network recovery base delay: 2s
Network recovery max delay: 45s
Network recovery max outage duration: 10m`),
  {
    networkRecovery: {
      enabled: true,
      baseDelayMs: 2_000,
      maxDelayMs: 45_000,
      maxOutageMs: 10 * 60_000,
    },
  },
);

assert.deepEqual(parseWorkerRuntimeConfig("Network recovery: disabled"), {
  networkRecovery: { enabled: false },
});
assert.deepEqual(parseWorkerRuntimeConfig("Network recovery maximum outage: unlimited"), {
  networkRecovery: { maxOutageMs: null },
});
assert.deepEqual(parseWorkerRuntimeConfig("Network recovery maximum outage: until cancelled"), {
  networkRecovery: { maxOutageMs: null },
});

for (const directive of [
  "Network recovery: maybe",
  "Network recovery base delay: 0ms",
  "Network recovery maximum delay: -1s",
  "Network recovery maximum outage: Infinity",
  "Network recovery base delay: 10s\nNetwork recovery maximum delay: 5s",
]) {
  assert.throws(() => parseWorkerRuntimeConfig(directive), /network.?recovery/i);
}
