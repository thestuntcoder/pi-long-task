import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, runTodoPlanner, type CoordinatorProgressUpdate } from "../src/coordinator.ts";
import { DEFAULT_PLANNER_TIMEOUT_MS, resolvePlannerBudget, type PlannerBudget } from "../src/planner_config.ts";
import {
  createPlannerActiveProgress,
  createPlannerGraceProgress,
  createPlannerStartedProgress,
  formatFriendlyDuration,
  plannerProgressCheckpoints,
  type PlannerProgressEvent,
} from "../src/planner_progress.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

function completedOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "start",
    endedAt: "end",
    reportedStatus: "done",
    done: true,
    assistantText:
      "TASK_RESULT:\nstatus: done\nsummary: complete\nchanges:\n- none\nverification:\n- not run\nremaining:\n- none",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

function defaultBudget(): PlannerBudget {
  return resolvePlannerBudget({ inputText: "Plan an ordinary feature." });
}

test("friendly duration formatter uses stable readable units", () => {
  assert.equal(formatFriendlyDuration(0), "0 seconds");
  assert.equal(formatFriendlyDuration(250), "less than 1 second");
  assert.equal(formatFriendlyDuration(1_000), "1 second");
  assert.equal(formatFriendlyDuration(15_000), "15 seconds");
  assert.equal(formatFriendlyDuration(90_000), "1 minute 30 seconds");
  assert.equal(formatFriendlyDuration(7_200_000), "2 hours");
  assert.equal(formatFriendlyDuration(90_000_000), "1 day 1 hour");
});

test("planner messages consistently describe default, explicit, adaptive, elapsed, and grace timing", () => {
  const ordinary = defaultBudget();
  const ordinaryStart = createPlannerStartedProgress(ordinary, 15_000);
  assert.match(ordinaryStart.message, /Effective planning budget: 5 minutes/);
  assert.match(ordinaryStart.message, /15-second graceful-shutdown period/);
  assert.doesNotMatch(ordinaryStart.message, /Adaptive extension/);
  assert.equal(ordinaryStart.budgetMs, DEFAULT_PLANNER_TIMEOUT_MS);
  assert.equal(ordinaryStart.remainingMs, DEFAULT_PLANNER_TIMEOUT_MS);

  const explicit = resolvePlannerBudget({
    inputText: "Plan 24 separately planned stories.",
    explicitTimeoutMs: 90_000,
  });
  const explicitStart = createPlannerStartedProgress(explicit, 0);
  assert.match(explicitStart.message, /1 minute 30 seconds \(explicitly configured\)/);
  assert.doesNotMatch(explicitStart.message, /Adaptive extension/);

  const adaptive = resolvePlannerBudget({ inputText: "Plan 24 separately planned stories." });
  const adaptiveStart = createPlannerStartedProgress(adaptive, 15_000);
  assert.match(adaptiveStart.message, /Effective planning budget: 15 minutes/);
  assert.match(adaptiveStart.message, /Adaptive extension: 10 minutes/);
  assert.match(adaptiveStart.message, /24 separately planned tasks/);

  const active = createPlannerActiveProgress(ordinary, 15_000, 75_000);
  assert.match(active.message, /1 minute 15 seconds elapsed/);
  assert.match(active.message, /3 minutes 45 seconds remaining/);
  assert.equal(active.elapsedMs, 75_000);
  assert.equal(active.remainingMs, 225_000);

  const grace = createPlannerGraceProgress(ordinary, 15_000);
  assert.match(grace.message, /budget reached after 5 minutes/);
  assert.match(grace.message, /entering a 15-second graceful-shutdown period/);
  assert.equal(grace.state, "grace");
  assert.equal(grace.graceRemainingMs, 15_000);

  assert.deepEqual(plannerProgressCheckpoints(300_000), [75_000, 150_000, 225_000]);
});

test("planner emits bounded elapsed updates and grace entry using a fake clock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const progress: PlannerProgressEvent[] = [];
  let resolvePromptStarted: (() => void) | undefined;
  let resolvePrompt: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStarted = resolve;
  });

  const plannerPromise = runTodoPlanner({
    inputText: "Plan a feature.",
    cwd: process.cwd(),
    runDir: path.join(process.cwd(), "tmp", "planner-progress-test"),
    timeoutMs: 4_000,
    gracefulShutdownMs: 2_000,
    onProgress: (event) => progress.push({ ...event }),
    sessionFactory: async () => ({
      session: {
        async prompt() {
          resolvePromptStarted?.();
          await new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });
        },
        subscribe: () => () => {},
        followUp: async () => {},
        abort: () => resolvePrompt?.(),
        dispose: () => {},
      },
    }),
  });

  await promptStarted;
  assert.deepEqual(
    progress.map((event) => event.state),
    ["started"],
  );
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(1_000);
  assert.deepEqual(
    progress.map((event) => event.elapsedMs),
    [0, 1_000, 2_000, 3_000],
  );
  assert.match(progress.at(-1)?.message ?? "", /3 seconds elapsed; about 1 second remaining/);

  t.mock.timers.tick(1_000);
  assert.equal(progress.at(-1)?.state, "grace");
  assert.equal(progress.at(-1)?.graceRemainingMs, 2_000);
  assert.match(progress.at(-1)?.message ?? "", /entering a 2-second graceful-shutdown period/);

  t.mock.timers.tick(2_000);
  await assert.rejects(plannerPromise, /TODO planner timed out/);
  assert.equal(progress.length, 5, "three checkpoints and one grace update avoid noisy output");
});

test("headless coordinator publishes elapsed and grace states using a fake clock", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-grace-progress-"));
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const updates: CoordinatorProgressUpdate[] = [];
    let resolvePromptStarted: (() => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });

    const coordinatorPromise = runCoordinator({
      inputText: "Build a feature from prose.",
      commit: false,
      cwd,
      runId: "headless-grace-progress",
      todoTimeoutMs: 4_000,
      todoGracefulShutdownMs: 2_000,
      todoSessionFactory: async () => ({
        session: {
          async prompt() {
            resolvePromptStarted?.();
            await new Promise<void>((resolve) => {
              resolvePrompt = resolve;
            });
          },
          subscribe: () => () => {},
          followUp: async () => {},
          abort: () => resolvePrompt?.(),
          dispose: () => {},
        },
      }),
      workerRunner: async (options) => completedOutcome(options),
      onProgress: (update) => updates.push(update),
    });

    await promptStarted;
    t.mock.timers.tick(1_000);
    assert.equal(updates.at(-1)?.plannerProgressState, "active");
    assert.equal(updates.at(-1)?.plannerElapsedMs, 1_000);
    assert.equal(updates.at(-1)?.plannerRemainingMs, 3_000);
    assert.match(updates.at(-1)?.message ?? "", /1 second elapsed; about 3 seconds remaining/);

    t.mock.timers.tick(3_000);
    const grace = updates.at(-1);
    assert.equal(grace?.plannerProgressState, "grace");
    assert.equal(grace?.plannerElapsedMs, 4_000);
    assert.equal(grace?.plannerRemainingMs, 0);
    assert.equal(grace?.plannerGraceRemainingMs, 2_000);
    assert.match(grace?.message ?? "", /entering a 2-second graceful-shutdown period/);

    t.mock.timers.tick(2_000);
    const result = await coordinatorPromise;
    assert.equal(result.status, "failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("headless coordinator progress exposes friendly messages and exact timing values for every budget source", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-progress-"));
  try {
    const cases = [
      {
        runId: "default-progress",
        inputText: "Build a feature from this prose.",
        expectedSource: "default",
        expectedMessage: /Effective planning budget: 5 minutes/,
      },
      {
        runId: "adaptive-progress",
        inputText: "Plan 24 separately planned stories.",
        expectedSource: "adaptive",
        expectedMessage: /Adaptive extension: 10 minutes.*24 separately planned tasks/,
      },
      {
        runId: "explicit-progress",
        inputText: "Build a configured feature.",
        todoTimeoutMs: 90_000,
        expectedSource: "explicit",
        expectedMessage: /1 minute 30 seconds \(explicitly configured\)/,
      },
    ] as const;

    for (const item of cases) {
      const updates: CoordinatorProgressUpdate[] = [];
      await runCoordinator({
        inputText: item.inputText,
        commit: false,
        cwd,
        runId: item.runId,
        ...("todoTimeoutMs" in item ? { todoTimeoutMs: item.todoTimeoutMs } : {}),
        todoPlanner: async () => generatedTodoMarkdown(["Complete planned work"]),
        workerRunner: async (options) => completedOutcome(options),
        onProgress: (update) => updates.push(update),
      });

      const start = updates[0];
      assert.equal(start?.phase, "planning");
      assert.equal(start?.plannerProgressState, "started");
      assert.equal(start?.plannerBudget?.source, item.expectedSource);
      assert.equal(start?.plannerElapsedMs, 0);
      assert.equal(start?.plannerRemainingMs, start?.plannerBudget?.timeoutMs);
      assert.equal(start?.plannerGracePeriodMs, 15_000);
      assert.match(start?.message ?? "", item.expectedMessage);
      if (item.expectedSource !== "adaptive") {
        assert.doesNotMatch(start?.message ?? "", /Adaptive extension/);
      }
      assert.doesNotMatch(start?.message ?? "", /\b\d+ms\b/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
