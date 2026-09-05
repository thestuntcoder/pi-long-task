import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";

import { runCoordinator, type TodoPlanner } from "../src/coordinator.ts";
import {
  DEFAULT_NETWORK_RECOVERY_CONFIG,
  NETWORK_RECOVERY_TIMEOUT_POLICY,
  NetworkRecoveryConfigError,
  resolveNetworkRecoveryConfig,
  type NetworkRecoveryConfig,
} from "../src/network_recovery_config.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import { PiGoalTaskParams, PiLongTaskParams } from "../src/types.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

const defaultConfig = resolveNetworkRecoveryConfig();
assert.deepEqual(defaultConfig, DEFAULT_NETWORK_RECOVERY_CONFIG);
assert.equal(Object.isFrozen(defaultConfig), true);
assert.equal(DEFAULT_NETWORK_RECOVERY_CONFIG.enabled, false);
assert.equal(DEFAULT_NETWORK_RECOVERY_CONFIG.timeoutPolicy, "exclude-network-wait");

assert.deepEqual(
  resolveNetworkRecoveryConfig({
    enabled: true,
    baseDelayMs: 2_000,
    maxDelayMs: 45_000,
    maxOutageMs: 10 * 60_000,
  }),
  {
    enabled: true,
    baseDelayMs: 2_000,
    maxDelayMs: 45_000,
    maxOutageMs: 10 * 60_000,
    timeoutPolicy: NETWORK_RECOVERY_TIMEOUT_POLICY,
  },
);

assert.deepEqual(resolveNetworkRecoveryConfig({ enabled: false }), DEFAULT_NETWORK_RECOVERY_CONFIG);
assert.equal(resolveNetworkRecoveryConfig({ enabled: true, maxOutageMs: 60_000 }).maxOutageMs, 60_000);
assert.equal(resolveNetworkRecoveryConfig({ enabled: true, maxOutageMs: null }).maxOutageMs, null);

assert.equal(
  Value.Check(PiLongTaskParams, {
    commit: false,
    networkRecovery: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000, maxOutageMs: null },
  }),
  true,
);
assert.equal(
  Value.Check(PiGoalTaskParams, {
    goal: "finish the project",
    networkRecovery: { enabled: false, maxOutageMs: 300_000 },
  }),
  true,
);
assert.equal(Value.Check(PiLongTaskParams, { commit: false, networkRecovery: { baseDelayMs: 0 } }), false);
assert.equal(Value.Check(PiLongTaskParams, { commit: false, networkRecovery: { enabled: true, unknown: 1 } }), false);

for (const invalid of [
  { enabled: "yes" },
  { baseDelayMs: 0 },
  { baseDelayMs: -1 },
  { baseDelayMs: Number.NaN },
  { baseDelayMs: Number.POSITIVE_INFINITY },
  { baseDelayMs: 1.5 },
  { maxDelayMs: 999 },
  { maxOutageMs: 999 },
] as Array<Record<string, unknown>>) {
  assert.throws(
    () => resolveNetworkRecoveryConfig(invalid as never),
    NetworkRecoveryConfigError,
    `expected invalid config to fail: ${JSON.stringify(invalid)}`,
  );
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-network-recovery-config-"));
try {
  const expected: NetworkRecoveryConfig = {
    enabled: true,
    baseDelayMs: 2_000,
    maxDelayMs: 8_000,
    maxOutageMs: null,
    timeoutPolicy: NETWORK_RECOVERY_TIMEOUT_POLICY,
  };
  let plannerConfig: Readonly<NetworkRecoveryConfig> | undefined;
  let workerConfig: Readonly<NetworkRecoveryConfig> | undefined;
  const planner: TodoPlanner = async (options) => {
    plannerConfig = options.networkRecovery;
    return generatedTodoMarkdown(["Verify normalized recovery config"]);
  };

  const result = await runCoordinator({
    inputText: "Plan and verify normalized recovery configuration.",
    commit: false,
    cwd: tempRoot,
    runId: "network-config-threading",
    networkRecovery: {
      enabled: true,
      baseDelayMs: 2_000,
      maxDelayMs: 8_000,
      maxOutageMs: null,
    },
    maxAttemptsPerTask: 1,
    todoPlanner: planner,
    workerRunner: async (options) => {
      workerConfig = options.networkRecovery;
      return doneOutcome(options);
    },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(plannerConfig, expected);
  assert.deepEqual(workerConfig, expected);
  assert.equal(result.attempts.length, 1, "recovery configuration must not alter ordinary task attempts");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function doneOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-05T00:00:00.000Z",
    endedAt: "2026-09-05T00:00:01.000Z",
    reportedStatus: "done",
    done: true,
    assistantText:
      "TASK_RESULT:\nstatus: done\nsummary: config reached worker\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}
