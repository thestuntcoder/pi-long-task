import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cancelGoalLoop,
  createGoalLoopState,
  goalLoopStopReason,
  normalizeGoalLoopLimits,
  recordGeneratedTodo,
  recordReviewerResult,
  recordWorkerResult,
  startGoalIteration,
} from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";

const baseTime = new Date("2026-06-25T08:00:00.000Z");

assert.deepEqual(normalizeGoalLoopLimits({ maxIterations: 2, timeoutMs: 1000 }), {
  maxIterations: 2,
  timeoutMs: 1000,
  iterationTimeoutMs: 10_800_000,
  reviewerTimeoutMs: 1_800_000,
});
assert.deepEqual(normalizeGoalLoopLimits({ maxIterations: 0, timeoutMs: -1 }).maxIterations, 50);

let state = createGoalLoopState({
  goal: "Ship the feature safely",
  goalRunId: "goal-state-test",
  cwd: "/repo",
  maxIterations: 2,
  timeoutMs: 10_000,
  now: () => baseTime,
});
assert.equal(state.phase, "goal_received");
assert.equal(state.status, "running");
assert.equal(state.iterations.length, 0);
assert.equal(state.trace.map((event) => event.event).join(" > "), "goal_received");

state = startGoalIteration(state, { now: new Date("2026-06-25T08:00:01.000Z") });
assert.equal(state.currentIteration, 1);
assert.equal(state.iterations[0]?.status, "pending");

state = recordGeneratedTodo(
  state,
  1,
  { todoPath: "/repo/tmp/pi-long-task/child-1/TODO.md", summary: "First plan" },
  { now: new Date("2026-06-25T08:00:02.000Z") },
);
assert.equal(state.phase, "todo_generated");
assert.equal(state.iterations[0]?.generatedTodo?.summary, "First plan");

state = recordWorkerResult(
  state,
  1,
  {
    status: "done",
    summary: "Child TODO completed",
    runId: "child-1",
    todoPath: "/repo/tmp/pi-long-task/child-1/TODO.md",
    resultPath: "/repo/tmp/pi-long-task/child-1/TASK_RESULT.md",
    completedTasks: 1,
    totalTasks: 1,
    workerCostTotal: 0.01,
    endedAt: "2026-06-25T08:00:03.000Z",
  },
  { now: new Date("2026-06-25T08:00:03.000Z") },
);
assert.equal(state.phase, "todo_executed");
assert.equal(state.iterations[0]?.workerResult?.status, "done");

state = recordReviewerResult(
  state,
  1,
  {
    decision: "incomplete",
    complete: false,
    summary: "More work remains",
    rationale: "A second pass is needed.",
    remainingWork: ["Add tests"],
    reviewedAt: "2026-06-25T08:00:04.000Z",
  },
  { now: new Date("2026-06-25T08:00:04.000Z") },
);
assert.equal(state.phase, "reviewed");
assert.equal(state.status, "running");
assert.equal(state.iterations[0]?.status, "reviewed_incomplete");

state = startGoalIteration(state, { now: new Date("2026-06-25T08:00:05.000Z") });
state = recordGeneratedTodo(state, 2, { todoPath: "/repo/tmp/pi-long-task/child-2/TODO.md" }, { now: baseTime });
state = recordWorkerResult(
  state,
  2,
  { status: "done", summary: "Second child completed", runId: "child-2", endedAt: "2026-06-25T08:00:06.000Z" },
  { now: new Date("2026-06-25T08:00:06.000Z") },
);
state = recordReviewerResult(
  state,
  2,
  {
    decision: "complete",
    complete: true,
    summary: "Goal achieved",
    rationale: "Reviewer verified the goal.",
    remainingWork: [],
    reviewedAt: "2026-06-25T08:00:07.000Z",
  },
  { now: new Date("2026-06-25T08:00:07.000Z") },
);
assert.equal(state.phase, "complete");
assert.equal(state.status, "done");
assert.equal(state.completion?.reason, "Reviewer verified the goal.");
assert.deepEqual(
  state.trace.map((event) => event.event),
  [
    "goal_received",
    "iteration_started",
    "todo_generated",
    "todo_executed",
    "reviewed",
    "iteration_started",
    "todo_generated",
    "todo_executed",
    "reviewed",
  ],
);

let limited = createGoalLoopState({
  goal: "Never loop forever",
  goalRunId: "goal-limit-test",
  maxIterations: 1,
  now: () => baseTime,
});
limited = startGoalIteration(limited, { now: baseTime });
limited = recordGeneratedTodo(limited, 1, { todoPath: "/tmp/one/TODO.md" }, { now: baseTime });
limited = recordWorkerResult(
  limited,
  1,
  { status: "done", summary: "Done", endedAt: baseTime.toISOString() },
  { now: baseTime },
);
limited = recordReviewerResult(
  limited,
  1,
  {
    decision: "incomplete",
    complete: false,
    summary: "Still incomplete",
    rationale: "Need more work.",
    remainingWork: ["More work"],
    reviewedAt: baseTime.toISOString(),
  },
  { now: baseTime },
);
assert.equal(goalLoopStopReason(limited, { now: baseTime })?.kind, "max_iterations");
limited = startGoalIteration(limited, { now: baseTime });
assert.equal(limited.status, "failed");
assert.match(limited.completion?.reason ?? "", /maxIterations=1/);

let cancelled = createGoalLoopState({ goal: "Cancelable", goalRunId: "goal-cancel-test", now: () => baseTime });
cancelled = startGoalIteration(cancelled, { now: baseTime });
cancelled = cancelGoalLoop(cancelled, "User cancelled", { now: baseTime });
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cancellation.requested, true);
assert.equal(cancelled.iterations[0]?.status, "cancelled");

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-state-test-"));
try {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "persisted" });
  const persisted = createGoalLoopState({
    goal: "Persist and resume",
    goalRunId: "persisted",
    cwd: tempRoot,
    now: () => baseTime,
  });
  await store.saveState(persisted);
  await store.initializeResult(persisted);
  await store.appendNewTraceEvents(0, persisted);
  const loaded = await store.loadState();
  assert.equal(loaded.goal, "Persist and resume");
  assert.equal(loaded.goalRunDir, store.paths.goalRunDir);
  const traceText = await readFile(store.paths.tracePath, "utf8");
  assert.match(traceText, /"event":"goal_received"/);
  const resultText = await readFile(store.paths.resultPath, "utf8");
  assert.match(resultText, /Max iterations: 5/);
  const snapshotPath = await store.writeIterationSnapshot(
    startGoalIteration(persisted, { now: baseTime }).iterations[0]!,
  );
  assert.match(snapshotPath, /iterations\/01\/ITERATION_STATE\.json$/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
