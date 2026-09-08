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
  DEFAULT_PLANNER_TIMEOUT_MS,
  MAX_ADAPTIVE_PLANNER_TIMEOUT_MS,
  MAX_PLANNER_DURATION_MS,
  MIN_ADAPTIVE_PLANNER_TIMEOUT_MS,
  PlannerDurationConfigError,
  PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS,
  detectPlannerComplexitySignals,
  resolvePlannerBudget,
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
  assert.equal(options.plannerBudget?.source, "explicit");
  assert.equal(options.plannerBudget?.extensionApplied, false);
});

test("planner duration directives propagate when structured options are absent", async () => {
  const options = await capturePlannerOptions(
    "Use a planning timeout of 90s and a planner grace period of 3s. Plan one implementation task.",
  );

  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.gracefulShutdownMs, 3_000);
  assert.equal(options.plannerBudget?.source, "explicit");
});

test("legacy coordinator calls retain planner duration defaults", async () => {
  const options = await capturePlannerOptions("Plan one implementation task.");

  assert.equal(options.timeoutMs, DEFAULT_COORDINATOR_OPTIONS.todoTimeoutMs);
  assert.equal(options.gracefulShutdownMs, DEFAULT_COORDINATOR_OPTIONS.todoGracefulShutdownMs);
  assert.equal(options.plannerBudget?.source, "default");
  assert.equal(options.plannerBudget?.extensionApplied, false);
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

test("adaptive planner budgets are deterministic, monotonic, and bounded", () => {
  const simpleInput = "Plan a reliable checkout flow.";
  const moderateInput = `Plan these deliverables:\n1. API contract\n2. Data model\n3. Service\n4. UI\n5. Validation\n6. Unit tests\n7. Integration tests\n8. Documentation`;
  const largeInput = "Create 24 separately planned user stories, with one independently assignable task per story.";
  const oversizedInput = "Create 100000 separately planned tasks.";

  const simple = resolvePlannerBudget({ inputText: simpleInput });
  const moderate = resolvePlannerBudget({ inputText: moderateInput });
  const large = resolvePlannerBudget({ inputText: largeInput });
  const oversized = resolvePlannerBudget({ inputText: oversizedInput });

  assert.deepEqual(resolvePlannerBudget({ inputText: largeInput }), large);
  assert.deepEqual(resolvePlannerBudget({ inputText: largeInput }), large);
  assert.equal(simple.timeoutMs, DEFAULT_PLANNER_TIMEOUT_MS);
  assert.equal(simple.source, "default");
  assert.equal(simple.extensionApplied, false);
  assert.ok(simple.timeoutMs < moderate.timeoutMs);
  assert.ok(moderate.timeoutMs < large.timeoutMs);
  assert.equal(moderate.timeoutMs, DEFAULT_PLANNER_TIMEOUT_MS + 4 * PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS);
  assert.equal(large.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
  assert.equal(oversized.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
  assert.equal(large.extensionApplied, true);
  assert.equal(large.trigger?.kind, "separately_planned_tasks");
  assert.equal(large.trigger?.itemCount, 24);
  assert.equal(large.minimumTimeoutMs, MIN_ADAPTIVE_PLANNER_TIMEOUT_MS);
  assert.equal(large.maximumTimeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
});

test("adaptive planner budget changes only above the included-item boundary", () => {
  const included = resolvePlannerBudget({ inputText: "Create 4 separately planned tasks." });
  const firstExtended = resolvePlannerBudget({ inputText: "Create 5 separately planned tasks." });

  assert.equal(included.timeoutMs, DEFAULT_PLANNER_TIMEOUT_MS);
  assert.equal(included.extensionApplied, false);
  assert.equal(firstExtended.timeoutMs, DEFAULT_PLANNER_TIMEOUT_MS + PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS);
  assert.equal(firstExtended.extensionMs, PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS);
});

test("complexity detector records explicit counts, enumeration, and separate-planning language", () => {
  const signals = detectPlannerComplexitySignals(
    "Create 6 separately planned stories:\n- Login\n- Logout\n- Recovery\n- Profile\n- Security\n- Audit",
  );

  assert.deepEqual(signals, [
    { kind: "separately_planned_tasks", itemCount: 6 },
    { kind: "explicit_item_count", itemCount: 6 },
    { kind: "enumerated_deliverables", itemCount: 6 },
  ]);
});

test("explicit planner timeout overrides bypass adaptive detection and bounds", () => {
  const complexInput = "Create 100000 separately planned tasks.";
  for (const timeoutMs of [1, 12_345, MAX_PLANNER_DURATION_MS]) {
    const budget = resolvePlannerBudget({ inputText: complexInput, explicitTimeoutMs: timeoutMs });
    assert.equal(budget.timeoutMs, timeoutMs);
    assert.equal(budget.source, "explicit");
    assert.equal(budget.extensionApplied, false);
    assert.equal(budget.extensionMs, 0);
    assert.deepEqual(budget.signals, []);
    assert.equal(budget.trigger, undefined);
  }
});

test("coordinator applies and records the 24-item adaptive planning budget", async () => {
  const options = await capturePlannerOptions(
    "Create 24 separately planned user stories, with one independently assignable task per story.",
  );

  assert.equal(options.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
  assert.equal(options.plannerBudget?.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
  assert.equal(options.plannerBudget?.extensionApplied, true);
  assert.equal(options.plannerBudget?.trigger?.kind, "separately_planned_tasks");
  assert.equal(options.plannerBudget?.trigger?.itemCount, 24);
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
