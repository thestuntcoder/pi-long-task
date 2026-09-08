import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_COORDINATOR_OPTIONS,
  runCoordinator,
  type TodoPlannerOptions,
  type WorkerRunner,
} from "../src/coordinator.ts";
import { runGoalLoop } from "../src/goal_orchestrator.ts";
import {
  MAX_PLANNER_DURATION_MS,
  PlannerDurationConfigError,
  resolvePlannerGracefulShutdownMs,
  resolvePlannerTimeoutMs,
} from "../src/planner_config.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { SessionOutcome } from "../src/worker_session.ts";

const successfulWorker: WorkerRunner = async (options): Promise<SessionOutcome> => ({
  task: options.task,
  attempt: options.attempt,
  startedAt: "2026-09-08T12:00:00.000Z",
  endedAt: "2026-09-08T12:00:01.000Z",
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
});

async function capturePlannerOptions(
  inputText: string,
  overrides: { todoTimeoutMs?: number; todoGracefulShutdownMs?: number } = {},
): Promise<TodoPlannerOptions> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-config-test-"));
  let captured: TodoPlannerOptions | undefined;
  try {
    await runCoordinator({
      inputText,
      cwd,
      runId: "planner-config",
      commit: false,
      workerRunner: successfulWorker,
      todoPlanner: async (options) => {
        captured = options;
        return generatedTodoMarkdown(["Complete the planned work"]);
      },
      ...overrides,
    });
    assert.ok(captured, "expected the coordinator to invoke the TODO planner");
    return captured;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("structured planner durations reach execution unchanged and override text directives", async () => {
  const options = await capturePlannerOptions(
    "Planner timeout: 7m\nPlanner graceful shutdown: 25s\nPlan one implementation task.",
    { todoTimeoutMs: 12_345, todoGracefulShutdownMs: 0 },
  );

  assert.equal(options.timeoutMs, 12_345);
  assert.equal(options.gracefulShutdownMs, 0);
});

test("planner duration directives propagate when structured options are absent", async () => {
  const options = await capturePlannerOptions(
    "Use a planning timeout of 90s and a planner grace period of 3s. Plan one implementation task.",
  );

  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.gracefulShutdownMs, 3_000);
});

test("legacy coordinator calls retain planner duration defaults", async () => {
  const options = await capturePlannerOptions("Plan one implementation task.");

  assert.equal(options.timeoutMs, DEFAULT_COORDINATOR_OPTIONS.todoTimeoutMs);
  assert.equal(options.gracefulShutdownMs, DEFAULT_COORDINATOR_OPTIONS.todoGracefulShutdownMs);
});

test("public runtime entry points reject invalid structured planner durations before work starts", async () => {
  let plannerCalls = 0;
  await assert.rejects(
    runCoordinator({
      inputText: "Plan one implementation task.",
      commit: false,
      todoTimeoutMs: 0,
      todoPlanner: async () => {
        plannerCalls += 1;
        return generatedTodoMarkdown(["Unexpected work"]);
      },
    }),
    /TODO planner timeout must be a positive whole-millisecond duration/,
  );
  assert.equal(plannerCalls, 0);

  await assert.rejects(
    runGoalLoop({ goal: "Plan one implementation task.", todoGracefulShutdownMs: -1 }),
    /TODO planner graceful-shutdown duration must be a non-negative whole-millisecond duration/,
  );
});

test("planner durations reject invalid programmatic values and preserve valid boundaries", () => {
  assert.equal(resolvePlannerTimeoutMs(1, 100), 1);
  assert.equal(resolvePlannerTimeoutMs(MAX_PLANNER_DURATION_MS, 100), MAX_PLANNER_DURATION_MS);
  assert.equal(resolvePlannerGracefulShutdownMs(0, 100), 0);

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PLANNER_DURATION_MS + 1]) {
    assert.throws(() => resolvePlannerTimeoutMs(invalid, 100), PlannerDurationConfigError);
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PLANNER_DURATION_MS + 1]) {
    assert.throws(() => resolvePlannerGracefulShutdownMs(invalid, 100), PlannerDurationConfigError);
  }
});
