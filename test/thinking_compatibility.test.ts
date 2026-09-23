import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_COORDINATOR_OPTIONS, runCoordinator, runTodoPlanner } from "../src/coordinator.ts";
import { DEFAULT_PLANNER_THINKING_LEVEL } from "../src/planner_config.ts";
import { DEFAULT_THINKING_FALLBACK_LEVEL, resolveAdaptiveThinkingLevel } from "../src/thinking_policy.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import {
  DEFAULT_WORKER_THINKING_LEVEL,
  type RunWorkerTaskOptions,
  type SessionOutcome,
  type WorkerSessionFactory,
} from "../src/worker_session.ts";

const completeTaskResult =
  "TASK_RESULT:\nstatus: done\nsummary: complete\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none";

function workerOutcome(options: RunWorkerTaskOptions, done = true): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-23T10:00:00.000Z",
    endedAt: "2026-09-23T10:00:01.000Z",
    reportedStatus: done ? "done" : "partial",
    done,
    assistantText: done
      ? completeTaskResult
      : "TASK_RESULT:\nstatus: partial\nsummary: continue\nchanges:\n- none\nverification:\n- pending\nremaining:\n- continue",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

async function withTempDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-compatibility-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function capturingPlannerFactory(levels: Array<string | undefined>): WorkerSessionFactory {
  return async (options) => {
    levels.push(options.thinkingLevel);
    return {
      session: {
        async prompt() {},
        getLastAssistantText: () => generatedTodoMarkdown(["Implement the planned change"]),
        subscribe: () => () => {},
      },
    };
  };
}

test("historical high defaults remain available as conservative compatibility fallbacks", () => {
  assert.equal(DEFAULT_THINKING_FALLBACK_LEVEL, "high");
  assert.equal(DEFAULT_PLANNER_THINKING_LEVEL, "high");
  assert.equal(DEFAULT_WORKER_THINKING_LEVEL, "high");
  assert.equal(DEFAULT_COORDINATOR_OPTIONS.todoThinking, "high");
  assert.equal(DEFAULT_COORDINATOR_OPTIONS.taskThinking, "high");

  const missing = resolveAdaptiveThinkingLevel({ taskKind: "worker" });
  const unclassified = resolveAdaptiveThinkingLevel({
    taskKind: "planner",
    inputText: "Implement the requested behavior.",
  });
  assert.deepEqual([missing.classification, missing.thinkingLevel, missing.source], ["ambiguous", "high", "fallback"]);
  assert.deepEqual(
    [unclassified.classification, unclassified.thinkingLevel, unclassified.source],
    ["ambiguous", "high", "fallback"],
  );
});

test("planner and worker explicit configuration independently outrank classification and model capabilities", async () => {
  await withTempDir(async (cwd) => {
    const plannerLevels: Array<string | undefined> = [];
    const workerLevels: Array<string | undefined> = [];
    const nonReasoningModel = { reasoning: false };

    const result = await runCoordinator({
      cwd,
      runId: "explicit-precedence",
      inputText: "Plan a production payment migration with encrypted customer data.",
      commit: false,
      todoThinking: "minimal",
      taskThinking: "provider-specific-worker-level",
      workerModel: nonReasoningModel,
      todoPlanner: async (options) => {
        plannerLevels.push(options.thinkingLevel);
        return generatedTodoMarkdown(["Fix a simple README typo"]);
      },
      workerRunner: async (options) => {
        workerLevels.push(options.thinkingLevel);
        return workerOutcome(options);
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(plannerLevels, ["minimal"]);
    assert.deepEqual(workerLevels, ["provider-specific-worker-level"]);
  });
});

test("direct planner overrides bypass adaptive selection even on non-reasoning models", async () => {
  await withTempDir(async (cwd) => {
    const explicitLevels: Array<string | undefined> = [];
    const adaptiveLevels: Array<string | undefined> = [];

    await runTodoPlanner({
      cwd,
      runDir: path.join(cwd, "explicit"),
      inputText: "Plan a simple README typo correction.",
      thinkingLevel: "provider-specific-planner-level",
      model: { reasoning: false },
      sessionFactory: capturingPlannerFactory(explicitLevels),
    });
    await runTodoPlanner({
      cwd,
      runDir: path.join(cwd, "adaptive"),
      inputText: "Plan a simple README typo correction.",
      model: { reasoning: false },
      sessionFactory: capturingPlannerFactory(adaptiveLevels),
    });

    assert.deepEqual(explicitLevels, ["provider-specific-planner-level"]);
    assert.deepEqual(adaptiveLevels, ["off"]);
  });
});

test("worker retries honor sparse model capabilities and clamp at the model maximum", async () => {
  await withTempDir(async (cwd) => {
    const levels: Array<string | undefined> = [];
    const sparseReasoningModel = {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    };

    const result = await runCoordinator({
      cwd,
      runId: "sparse-worker-capabilities",
      inputText: generatedTodoMarkdown(["Fix a simple README typo"]),
      commit: false,
      workerModel: sparseReasoningModel,
      maxAttemptsPerTask: 4,
      workerRunner: async (options) => {
        levels.push(options.thinkingLevel);
        return workerOutcome(options, options.attempt === 4);
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(levels, ["low", "high", "high", "high"]);
  });
});

test("non-reasoning model compatibility keeps adaptive worker retries off", async () => {
  await withTempDir(async (cwd) => {
    const levels: Array<string | undefined> = [];
    const result = await runCoordinator({
      cwd,
      runId: "non-reasoning-worker",
      inputText: generatedTodoMarkdown(["Fix a simple README typo"]),
      commit: false,
      workerModel: { reasoning: false },
      maxAttemptsPerTask: 3,
      workerRunner: async (options) => {
        levels.push(options.thinkingLevel);
        return workerOutcome(options, options.attempt === 3);
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(levels, ["off", "off", "off"]);
  });
});
