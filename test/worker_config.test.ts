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
