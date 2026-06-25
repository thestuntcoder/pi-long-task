import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { runGoalLoop } from "../src/goal_orchestrator.ts";
import { buildGoalReviewTaskPayload, parseGoalReviewerOutput } from "../src/goal_review.ts";
import { createGoalLoopState, recordGeneratedTodo, recordWorkerResult, startGoalIteration } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";

const baseTime = new Date("2026-06-25T11:00:00.000Z");

const parsed = parseGoalReviewerOutput(
  `Review result:\n\n\`\`\`json\n{"decision":"incomplete","complete":false,"summary":"Needs another pass","rationale":"Tests are missing","remainingWork":["Add tests"]}\n\`\`\``,
  { now: baseTime },
);
assert.equal(parsed.decision, "incomplete");
assert.equal(parsed.complete, false);
assert.deepEqual(parsed.remainingWork, ["Add tests"]);
assert.equal(parsed.reviewedAt, baseTime.toISOString());

let payloadState = createGoalLoopState({
  goal: "Review payload includes worker result",
  goalRunId: "goal-review-payload",
  now: () => baseTime,
});
payloadState = startGoalIteration(payloadState, { now: baseTime });
payloadState = recordGeneratedTodo(payloadState, 1, { todoPath: "/tmp/generated/TODO.md" }, { now: baseTime });
payloadState = recordWorkerResult(
  payloadState,
  1,
  { status: "done", summary: "Worker finished", endedAt: baseTime.toISOString() },
  { now: baseTime },
);
const payload = buildGoalReviewTaskPayload({ state: payloadState, iteration: payloadState.iterations[0]! });
assert.match(payload, /Original high-level goal/);
assert.match(payload, /Worker finished/);
assert.match(payload, /Reply with only one JSON object/);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-review-loop-test-"));
try {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-review-loop" });
  const generationInputs: string[] = [];
  const fakeGenerationRunner = async (options: RunCoordinatorOptions): Promise<CoordinatorResult> => {
    generationInputs.push(options.inputText ?? "");
    const outputPath = extractGenerationOutputPath(options.inputText ?? "");
    const iteration = generationInputs.length;
    await writeFile(outputPath, sampleTodoMarkdown(iteration), "utf8");
    return coordinatorResult(options, `Generated TODO for iteration ${iteration}`);
  };

  const executionInputs: string[] = [];
  const fakeExecutionRunner = async (options: RunCoordinatorOptions): Promise<CoordinatorResult> => {
    executionInputs.push(options.inputText ?? "");
    return {
      ...coordinatorResult(options, "Worker completed generated TODO"),
      totalTasks: 1,
      completedTasks: 1,
      attemptedTasks: 1,
    };
  };

  const reviewerPrompts: string[] = [];
  const fakeReviewerRunner = async (options: { prompt: string }) => {
    reviewerPrompts.push(options.prompt);
    if (reviewerPrompts.length === 1) {
      return {
        assistantText: JSON.stringify({
          decision: "incomplete",
          complete: false,
          summary: "One more iteration is required",
          rationale: "The first worker only created the scaffold; verification remains.",
          remainingWork: ["Add verification evidence in a follow-up TODO"],
        }),
        reviewerSessionId: "reviewer-1",
        reviewerSessionFile: path.join(tempRoot, "reviewer-1.json"),
      };
    }
    return {
      assistantText: JSON.stringify({
        decision: "complete",
        complete: true,
        summary: "Goal is complete",
        rationale: "The second worker finished the remaining verification work.",
        remainingWork: [],
      }),
      reviewerSessionId: "reviewer-2",
      reviewerSessionFile: path.join(tempRoot, "reviewer-2.json"),
    };
  };

  const result = await runGoalLoop({
    goal: "Create a feature that intentionally requires a follow-up verification iteration",
    cwd: tempRoot,
    goalRunId: "goal-review-loop",
    store,
    maxIterations: 3,
    commit: false,
    todoGenerationRunner: fakeGenerationRunner,
    todoExecutionRunner: fakeExecutionRunner,
    reviewerRunner: fakeReviewerRunner,
    now: () => new Date("2026-06-25T11:00:01.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.state.phase, "complete");
  assert.equal(result.state.iterations.length, 2);
  assert.equal(result.generationResults.length, 2);
  assert.equal(result.executionResults.length, 2);
  assert.equal(result.reviewResults.length, 2);
  assert.equal(generationInputs.length, 2);
  assert.match(generationInputs[1] ?? "", /Add verification evidence/);
  assert.match(reviewerPrompts[0] ?? "", /Original high-level goal/);
  assert.match(reviewerPrompts[0] ?? "", /Worker completed generated TODO/);
  assert.equal(result.state.iterations[0]?.reviewerResult?.decision, "incomplete");
  assert.equal(result.state.iterations[1]?.reviewerResult?.decision, "complete");
  assert.equal(result.state.iterations[0]?.reviewerResult?.reviewerSessionId, "reviewer-1");

  const loadedState = await store.loadState();
  assert.equal(loadedState.status, "done");
  assert.equal(loadedState.iterations.length, 2);

  const firstRawReview = await readFile(result.reviewResults[0]!.rawReviewPath, "utf8");
  assert.match(firstRawReview, /One more iteration is required/);
  const goalResult = await readFile(store.paths.resultPath, "utf8");
  assert.match(goalResult, /### Reviewer result/);
  assert.match(goalResult, /Decision: incomplete/);
  assert.match(goalResult, /Decision: complete/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function sampleTodoMarkdown(iteration: number): string {
  return `# Pi Long Task TODO

## Progress

- [ ] TODO 1 — Iteration ${iteration} work

---

## TODO 1 — Iteration ${iteration} work

**Goal:** Complete iteration ${iteration} work.

**Status:**
- [ ] Perform the focused iteration ${iteration} work.

**Verify:**
- Confirm iteration ${iteration} work is observable.

**Done when:**
- Iteration ${iteration} work is complete.
`;
}

function coordinatorResult(options: RunCoordinatorOptions, summary: string): CoordinatorResult {
  const runId = options.runId ?? "child-run";
  const runDir = path.join("/tmp", runId);
  return {
    status: "done",
    summary,
    message: summary,
    runId,
    runDir,
    todoPath: path.join(runDir, "TODO.md"),
    resultPath: path.join(runDir, "TASK_RESULT.md"),
    taskResultPath: path.join(runDir, "TASK_RESULT.md"),
    totalTasks: 1,
    completedTasks: 1,
    failedTasks: 0,
    blockedTasks: 0,
    attemptedTasks: 1,
    remainingTasks: [],
    outcomes: [],
    commits: [],
    attempts: [],
    taskProgress: buildTaskProgressModel({ tasks: [] }),
    workerCostTotal: 0,
    commit: options.commit,
    goal: options.goal,
  };
}

function extractGenerationOutputPath(payloadText: string): string {
  const match = /Write the generated Pi Long Task-compatible TODO markdown to `([^`]+)`/.exec(payloadText);
  assert.ok(match?.[1], "expected output path in generation payload");
  return match[1];
}
