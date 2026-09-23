import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, runTodoPlanner } from "../src/coordinator.ts";
import { resolveAdaptiveThinkingLevel } from "../src/thinking_policy.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome, WorkerSessionLike } from "../src/worker_session.ts";

const completeResult =
  "TASK_RESULT:\nstatus: done\nsummary: complete\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none";

function outcome(options: RunWorkerTaskOptions, done: boolean, failure?: unknown): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-23T00:00:00.000Z",
    endedAt: "2026-09-23T00:00:01.000Z",
    reportedStatus: done ? "done" : "partial",
    done,
    assistantText: done
      ? completeResult
      : "TASK_RESULT:\nstatus: partial\nsummary: retry\nchanges:\n- none\nverification:\n- not run\nremaining:\n- retry",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
    ...(failure === undefined ? {} : { error: String((failure as Error).message), failure }),
  };
}

async function withTempDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-retry-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("adaptive attempts increase monotonically through supported levels and clamp at the maximum", () => {
  const levels = Array.from(
    { length: 7 },
    (_, index) =>
      resolveAdaptiveThinkingLevel({
        taskKind: "worker",
        inputText: "Fix a simple README typo.",
        attempt: index + 1,
      }).thinkingLevel,
  );
  assert.deepEqual(levels, ["low", "medium", "high", "xhigh", "max", "max", "max"]);

  const sparseLevels = Array.from(
    { length: 4 },
    (_, index) =>
      resolveAdaptiveThinkingLevel({
        taskKind: "planner",
        inputText: "Plan a simple README typo correction.",
        supportedThinkingLevels: ["minimal", "low", "high"],
        attempt: index + 1,
      }).thinkingLevel,
  );
  assert.deepEqual(sparseLevels, ["low", "high", "high", "high"]);

  const conservativeLevels = Array.from(
    { length: 4 },
    (_, index) =>
      resolveAdaptiveThinkingLevel({
        taskKind: "worker",
        inputText: "Investigate an unclear failure.",
        attempt: index + 1,
      }).thinkingLevel,
  );
  assert.deepEqual(conservativeLevels, ["high", "xhigh", "max", "max"]);
});

test("explicit thinking overrides remain unchanged on every retry", () => {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const selected = resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Fix a simple README typo.",
      explicitThinkingLevel: "minimal",
      supportedThinkingLevels: ["low", "high"],
      attempt,
    });
    assert.equal(selected.thinkingLevel, "minimal");
    assert.equal(selected.source, "explicit");
  }
});

test("ordinary worker attempts escalate while explicit worker overrides do not", async () => {
  await withTempDir(async (cwd) => {
    const adaptiveLevels: Array<string | undefined> = [];
    const adaptive = await runCoordinator({
      cwd,
      runId: "ordinary-adaptive",
      inputText: generatedTodoMarkdown(["Fix a simple README typo"]),
      commit: false,
      maxAttemptsPerTask: 5,
      workerRunner: async (options) => {
        adaptiveLevels.push(options.thinkingLevel);
        return outcome(options, options.attempt === 5);
      },
    });
    assert.equal(adaptive.status, "done");
    assert.deepEqual(adaptiveLevels, ["low", "medium", "high", "xhigh", "max"]);

    const explicitLevels: Array<string | undefined> = [];
    await runCoordinator({
      cwd,
      runId: "ordinary-explicit",
      inputText: generatedTodoMarkdown(["Fix a simple README typo"]),
      commit: false,
      maxAttemptsPerTask: 3,
      taskThinking: "minimal",
      workerRunner: async (options) => {
        explicitLevels.push(options.thinkingLevel);
        return outcome(options, options.attempt === 3);
      },
    });
    assert.deepEqual(explicitLevels, ["minimal", "minimal", "minimal"]);
  });
});

test("worker and planner network retries escalate without consuming ordinary attempts", async () => {
  await withTempDir(async (cwd) => {
    const workerLevels: Array<string | undefined> = [];
    const workerResult = await runCoordinator({
      cwd,
      runId: "worker-network",
      inputText: generatedTodoMarkdown(["Fix a simple README typo"]),
      commit: false,
      maxAttemptsPerTask: 1,
      workerRunner: async (options) => {
        workerLevels.push(options.thinkingLevel);
        return workerLevels.length === 1
          ? outcome(options, false, Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
          : outcome(options, true);
      },
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 100 },
    });
    assert.equal(workerResult.attemptedTasks, 1);
    assert.deepEqual(workerLevels, ["low", "medium"]);

    const plannerLevels: Array<string | undefined> = [];
    const plannerResult = await runCoordinator({
      cwd,
      runId: "planner-network",
      inputText: "Plan a simple README typo correction.",
      commit: false,
      maxAttemptsPerTask: 1,
      todoPlanner: async (options) => {
        plannerLevels.push(options.thinkingLevel);
        if (plannerLevels.length === 1) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        }
        return generatedTodoMarkdown(["Fix a simple README typo"]);
      },
      workerRunner: async (options) => outcome(options, true),
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 100 },
    });
    assert.equal(plannerResult.status, "done");
    assert.deepEqual(plannerLevels, ["low", "medium"]);

    const explicitPlannerLevels: Array<string | undefined> = [];
    await runCoordinator({
      cwd,
      runId: "planner-network-explicit",
      inputText: "Plan a simple README typo correction.",
      commit: false,
      todoThinking: "minimal",
      maxAttemptsPerTask: 1,
      todoPlanner: async (options) => {
        explicitPlannerLevels.push(options.thinkingLevel);
        if (explicitPlannerLevels.length === 1) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        }
        return generatedTodoMarkdown(["Fix a simple README typo"]);
      },
      workerRunner: async (options) => outcome(options, true),
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 100 },
    });
    assert.deepEqual(explicitPlannerLevels, ["minimal", "minimal"]);
  });
});

test("planner output repair escalates adaptive thinking in custom and SDK planner paths", async () => {
  await withTempDir(async (cwd) => {
    const customLevels: Array<string | undefined> = [];
    const customResult = await runCoordinator({
      cwd,
      runId: "planner-custom-repair",
      inputText: "Plan a simple README typo correction.",
      commit: false,
      todoPlanner: async (options) => {
        customLevels.push(options.thinkingLevel);
        return customLevels.length === 1 ? "invalid planner output" : generatedTodoMarkdown(["Fix one README typo"]);
      },
      workerRunner: async (options) => outcome(options, true),
    });
    assert.equal(customResult.status, "done");
    assert.deepEqual(customLevels, ["low", "medium"]);

    const initialLevels: Array<string | undefined> = [];
    const changedLevels: string[] = [];
    let promptCount = 0;
    const session: WorkerSessionLike = {
      async prompt() {
        promptCount += 1;
      },
      getLastAssistantText: () =>
        promptCount === 1 ? "invalid planner output" : generatedTodoMarkdown(["Fix one README typo"]),
      subscribe: () => () => {},
      setThinkingLevel: (level) => changedLevels.push(level),
    };
    await runTodoPlanner({
      cwd,
      runDir: path.join(cwd, "direct-repair"),
      inputText: "Plan a simple README typo correction.",
      sessionFactory: async (options) => {
        initialLevels.push(options.thinkingLevel);
        return { session };
      },
    });
    assert.deepEqual(initialLevels, ["low"]);
    assert.deepEqual(changedLevels, ["medium"]);

    let explicitPromptCount = 0;
    const explicitInitialLevels: Array<string | undefined> = [];
    const explicitChangedLevels: string[] = [];
    await runTodoPlanner({
      cwd,
      runDir: path.join(cwd, "direct-explicit-repair"),
      inputText: "Plan a simple README typo correction.",
      thinkingLevel: "minimal",
      sessionFactory: async (options) => {
        explicitInitialLevels.push(options.thinkingLevel);
        return {
          session: {
            async prompt() {
              explicitPromptCount += 1;
            },
            getLastAssistantText: () =>
              explicitPromptCount === 1 ? "invalid planner output" : generatedTodoMarkdown(["Fix one README typo"]),
            subscribe: () => () => {},
            setThinkingLevel: (level) => explicitChangedLevels.push(level),
          },
        };
      },
    });
    assert.deepEqual(explicitInitialLevels, ["minimal"]);
    assert.deepEqual(explicitChangedLevels, []);
  });
});
