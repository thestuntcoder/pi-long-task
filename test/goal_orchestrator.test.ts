import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { runGoalLoop, type GoalLoopProgressUpdate } from "../src/goal_orchestrator.ts";
import type { GoalReviewerRunner } from "../src/goal_review.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { createGoalSpecification } from "../src/goal_spec.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";

await withTempRoot("pi-goal-orchestrator-one-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-one-iteration" });
  const generationInputs: string[] = [];
  const executionInputs: string[] = [];
  const reviewerPrompts: string[] = [];
  const progressUpdates: GoalLoopProgressUpdate[] = [];

  const result = await runGoalLoop({
    goal: "Ship a goal loop feature in one pass",
    cwd: tempRoot,
    goalRunId: "goal-one-iteration",
    store,
    maxIterations: 2,
    commit: false,
    todoGenerationRunner: async (options) => {
      generationInputs.push(options.inputText ?? "");
      assert.equal(options.commit, false);
      assert.equal(options.goal, "Ship a goal loop feature in one pass");
      assert.match(options.inputText ?? "", /Persisted goal specification/);
      assert.match(options.inputText ?? "", /REQ-1/);
      assert.match(options.inputText ?? "", /MS-1/);
      assert.match(options.inputText ?? "", /AC-1/);
      assert.match(options.inputText ?? "", /VG-1/);
      const outputPath = extractGenerationOutputPath(options.inputText ?? "");
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated one-pass TODO", { workerCostTotal: 0.01 });
    },
    todoExecutionRunner: async (options) => {
      executionInputs.push(options.inputText ?? "");
      assert.equal(options.commit, false);
      assert.equal(options.goal, "Ship a goal loop feature in one pass");
      assert.match(options.inputText ?? "", /TODO 1 — Iteration 1 work/);
      return coordinatorResult(options, "Worker completed one-pass TODO", {
        completedTasks: 1,
        attemptedTasks: 1,
        workerCostTotal: 0.02,
      });
    },
    reviewerRunner: async (options) => {
      reviewerPrompts.push(options.prompt);
      assert.equal(options.timeoutMs, 1_800_000);
      assert.match(options.prompt, /Original high-level goal/);
      assert.match(options.prompt, /Persisted goal specification \(primary review target\)/);
      assert.match(options.prompt, /persisted definition-of-done is satisfied/);
      assert.match(options.prompt, /REQ-1/);
      assert.match(options.prompt, /MS-1/);
      assert.match(options.prompt, /AC-1/);
      assert.match(options.prompt, /VG-1/);
      assert.match(options.prompt, /Worker completed one-pass TODO/);
      return reviewerResult(
        "complete",
        "Goal is complete for REQ-1 and AC-1",
        "The one-pass worker satisfied REQ-1, AC-1, and required verification gate VG-1.",
      );
    },
    onProgress: (update) => progressUpdates.push(update),
    now: () => new Date("2026-06-25T12:00:00.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.state.phase, "complete");
  assert.equal(result.state.iterations.length, 1);
  assert.equal(result.state.iterations[0]?.status, "reviewed_complete");
  assert.equal(result.generationResults.length, 1);
  assert.equal(result.executionResults.length, 1);
  assert.equal(result.reviewResults.length, 1);
  assert.equal(generationInputs.length, 1);
  assert.equal(executionInputs.length, 1);
  assert.equal(reviewerPrompts.length, 1);
  assert.deepEqual(
    progressUpdates.map((update) => update.phase),
    [
      "goal_start",
      "discovery_start",
      "discovery_complete",
      "todo_generation_start",
      "todo_generated",
      "todo_execution_start",
      "todo_executed",
      "review_start",
      "reviewed",
      "complete",
    ],
  );
  assert.equal(progressUpdates.at(-1)?.status, "done");
  assert.equal(progressUpdates.at(-1)?.totalCost, 0.03);
  assert.equal(result.discoveryDecision.route, "discovery");
  const loadedSpec = await store.loadGoalSpecification();
  assert.equal(loadedSpec.originalGoal, "Ship a goal loop feature in one pass");

  const loadedState = await store.loadState();
  assert.equal(loadedState.status, "done");
  assert.equal(loadedState.iterations[0]?.reviewerResult?.decision, "complete");
  assert.match(loadedState.iterations[0]?.reviewerResult?.summary ?? "", /REQ-1/);
  assert.match(loadedState.iterations[0]?.reviewerResult?.rationale ?? "", /AC-1/);
  const resultText = await readFile(store.paths.resultPath, "utf8");
  assert.match(resultText, /Decision: complete/);
  const traceText = await readFile(store.paths.tracePath, "utf8");
  assert.match(traceText, /"event":"reviewed"/);
});

await withTempRoot("pi-goal-orchestrator-concrete-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-concrete-direct" });
  const progressUpdates: GoalLoopProgressUpdate[] = [];
  const concreteGoal =
    "Update src/example.ts to export a parseExample function, add tests in test/example.test.ts, and run npm test -- example.";
  let generationCalls = 0;
  let discoveryCalls = 0;
  const reviewerPrompts: string[] = [];

  const result = await runGoalLoop({
    goal: concreteGoal,
    cwd: tempRoot,
    goalRunId: "goal-concrete-direct",
    store,
    maxIterations: 1,
    commit: false,
    discoveryRunner: async () => {
      discoveryCalls += 1;
      throw new Error("discovery should not run for concrete goals");
    },
    todoGenerationRunner: async (options) => {
      generationCalls += 1;
      assert.equal(options.goal, concreteGoal);
      assert.doesNotMatch(options.inputText ?? "", /Persisted goal specification/);
      const outputPath = extractGenerationOutputPath(options.inputText ?? "");
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated concrete TODO");
    },
    todoExecutionRunner: async (options) => coordinatorResult(options, "Worker completed concrete TODO"),
    reviewerRunner: async (options) => {
      reviewerPrompts.push(options.prompt);
      assert.match(options.prompt, /Original high-level goal/);
      assert.doesNotMatch(options.prompt, /Persisted goal specification/);
      return reviewerResult("complete", "Concrete goal complete", "The concrete goal was satisfied.");
    },
    onProgress: (update) => progressUpdates.push(update),
    now: () => new Date("2026-06-25T12:05:00.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.discoveryDecision.route, "direct");
  assert.equal(result.goalSpecification, undefined);
  assert.equal(discoveryCalls, 0);
  assert.equal(generationCalls, 1);
  assert.equal(reviewerPrompts.length, 1);
  assert.equal(await store.tryLoadGoalSpecification(), undefined);
  assert.deepEqual(
    progressUpdates.map((update) => update.phase),
    [
      "goal_start",
      "todo_generation_start",
      "todo_generated",
      "todo_execution_start",
      "todo_executed",
      "review_start",
      "reviewed",
      "complete",
    ],
  );
});

await withTempRoot("pi-goal-orchestrator-reuse-spec-", async (tempRoot) => {
  const goalRunId = "goal-reuse-persisted-spec";
  const goal = "Build a team dashboard";
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId });
  const persistedSpec = persistedDashboardSpec(goalRunId, goal);
  await store.saveGoalSpecification(persistedSpec);

  let discoveryCalls = 0;
  let generationPrompt = "";
  let reviewerPrompt = "";
  const progressUpdates: GoalLoopProgressUpdate[] = [];

  const result = await runGoalLoop({
    goal,
    cwd: tempRoot,
    goalRunId,
    store,
    maxIterations: 1,
    commit: false,
    discoveryRunner: async () => {
      discoveryCalls += 1;
      throw new Error("discovery should not rerun when a persisted spec already exists");
    },
    todoGenerationRunner: async (options) => {
      generationPrompt = options.inputText ?? "";
      assert.match(generationPrompt, /Persisted goal specification \(source of truth for implementation TODOs\)/);
      assert.match(generationPrompt, /Goal spec path: .*GOAL_SPEC\.json/);
      assert.match(generationPrompt, /REQ-PERSIST/);
      assert.match(generationPrompt, /MS-PERSIST/);
      assert.match(generationPrompt, /AC-PERSIST/);
      assert.match(generationPrompt, /VG-PERSIST/);
      const outputPath = extractGenerationOutputPath(generationPrompt);
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated persisted-spec TODO");
    },
    todoExecutionRunner: async (options) => coordinatorResult(options, "Worker completed persisted-spec TODO"),
    reviewerRunner: async (options) => {
      reviewerPrompt = options.prompt;
      assert.match(reviewerPrompt, /Persisted goal specification \(primary review target\)/);
      assert.match(reviewerPrompt, /Goal spec path: .*GOAL_SPEC\.json/);
      assert.match(reviewerPrompt, /REQ-PERSIST/);
      assert.match(reviewerPrompt, /MS-PERSIST/);
      assert.match(reviewerPrompt, /AC-PERSIST/);
      assert.match(reviewerPrompt, /VG-PERSIST/);
      return reviewerResult(
        "complete",
        "Persisted spec complete for REQ-PERSIST",
        "The worker satisfied REQ-PERSIST, AC-PERSIST, and required gate VG-PERSIST.",
      );
    },
    onProgress: (update) => progressUpdates.push(update),
    now: () => new Date("2026-06-25T12:07:00.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.discoveryDecision.route, "discovery");
  assert.equal(discoveryCalls, 0);
  assert.deepEqual(result.goalSpecification, persistedSpec);
  assert.deepEqual(await store.loadGoalSpecification(), persistedSpec);
  assert.deepEqual(
    progressUpdates.map((update) => update.phase),
    [
      "goal_start",
      "discovery_complete",
      "todo_generation_start",
      "todo_generated",
      "todo_execution_start",
      "todo_executed",
      "review_start",
      "reviewed",
      "complete",
    ],
  );
  assert.match(reviewerPrompt, /primary review target/);
});

await withTempRoot("pi-goal-orchestrator-long-entrypoint-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-long-entrypoint-direct" });
  const progressUpdates: GoalLoopProgressUpdate[] = [];
  let discoveryCalls = 0;
  let generationPrompt = "";
  let reviewerPrompt = "";

  const result = await runGoalLoop({
    goal: "Build a team dashboard",
    cwd: tempRoot,
    goalRunId: "goal-long-entrypoint-direct",
    store,
    maxIterations: 1,
    commit: false,
    discoveryEntrypoint: "pi_long_task",
    discoveryRunner: async () => {
      discoveryCalls += 1;
      throw new Error("pi_long_task entrypoint should keep direct long-task behavior");
    },
    todoGenerationRunner: async (options) => {
      generationPrompt = options.inputText ?? "";
      assert.doesNotMatch(generationPrompt, /Persisted goal specification/);
      const outputPath = extractGenerationOutputPath(generationPrompt);
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated direct-entrypoint TODO");
    },
    todoExecutionRunner: async (options) => coordinatorResult(options, "Worker completed direct-entrypoint TODO"),
    reviewerRunner: async (options) => {
      reviewerPrompt = options.prompt;
      assert.doesNotMatch(reviewerPrompt, /Persisted goal specification/);
      return reviewerResult("complete", "Direct entrypoint complete", "The direct long-task path completed.");
    },
    onProgress: (update) => progressUpdates.push(update),
    now: () => new Date("2026-06-25T12:08:00.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.discoveryDecision.classification, "vague");
  assert.equal(result.discoveryDecision.route, "direct");
  assert.equal(result.goalSpecification, undefined);
  assert.equal(discoveryCalls, 0);
  assert.equal(await store.tryLoadGoalSpecification(), undefined);
  assert.deepEqual(
    progressUpdates.map((update) => update.phase),
    [
      "goal_start",
      "todo_generation_start",
      "todo_generated",
      "todo_execution_start",
      "todo_executed",
      "review_start",
      "reviewed",
      "complete",
    ],
  );
});

await withTempRoot("pi-goal-orchestrator-two-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-two-iterations" });
  const generationInputs: string[] = [];
  const executionInputs: string[] = [];
  const reviewer: GoalReviewerRunner = async (options) => {
    if (options.prompt.includes("Iteration: 1")) {
      return reviewerResult(
        "incomplete",
        "More work remains",
        "The first iteration left verification evidence unfinished.",
        ["Add verification evidence in a second iteration"],
      );
    }
    return reviewerResult("complete", "Goal is complete", "The second iteration finished the verification evidence.");
  };

  const result = await runGoalLoop({
    goal: "Complete a goal that needs a follow-up iteration",
    cwd: tempRoot,
    goalRunId: "goal-two-iterations",
    store,
    maxIterations: 3,
    commit: true,
    todoGenerationRunner: async (options) => {
      generationInputs.push(options.inputText ?? "");
      const outputPath = extractGenerationOutputPath(options.inputText ?? "");
      await writeFile(outputPath, sampleTodoMarkdown(generationInputs.length), "utf8");
      return coordinatorResult(options, `Generated iteration ${generationInputs.length} TODO`);
    },
    todoExecutionRunner: async (options) => {
      executionInputs.push(options.inputText ?? "");
      assert.equal(options.commit, true);
      return coordinatorResult(options, `Worker completed iteration ${executionInputs.length}`);
    },
    reviewerRunner: reviewer,
    now: () => new Date("2026-06-25T12:10:00.000Z"),
  });

  assert.equal(result.state.status, "done");
  assert.equal(result.state.iterations.length, 2);
  assert.equal(result.generationResults.length, 2);
  assert.equal(result.executionResults.length, 2);
  assert.equal(result.reviewResults.length, 2);
  assert.match(generationInputs[1] ?? "", /Add verification evidence in a second iteration/);
  assert.equal(result.state.iterations[0]?.reviewerResult?.decision, "incomplete");
  assert.deepEqual(result.state.iterations[0]?.reviewerResult?.remainingWork, [
    "Add verification evidence in a second iteration",
  ]);
  assert.equal(result.state.iterations[1]?.reviewerResult?.decision, "complete");
});

await withTempRoot("pi-goal-orchestrator-cancel-", async (tempRoot) => {
  const abortController = new AbortController();
  abortController.abort();
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-cancelled" });

  const result = await runGoalLoop({
    goal: "Cancel before any child work starts",
    cwd: tempRoot,
    goalRunId: "goal-cancelled",
    store,
    abortSignal: abortController.signal,
    todoGenerationRunner: async () => {
      throw new Error("generation should not run after cancellation");
    },
    todoExecutionRunner: async () => {
      throw new Error("execution should not run after cancellation");
    },
    reviewerRunner: async () => {
      throw new Error("review should not run after cancellation");
    },
    now: () => new Date("2026-06-25T12:20:00.000Z"),
  });

  assert.equal(result.state.status, "cancelled");
  assert.equal(result.state.phase, "cancelled");
  assert.equal(result.state.iterations.length, 0);
  assert.equal(result.generationResults.length, 0);
  assert.equal(result.executionResults.length, 0);
  assert.equal(result.reviewResults.length, 0);
  assert.match(result.state.completion?.reason ?? "", /abort signal/);
});

await withTempRoot("pi-goal-orchestrator-failure-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-failed" });

  const result = await runGoalLoop({
    goal: "Stop when the worker and reviewer determine the goal failed",
    cwd: tempRoot,
    goalRunId: "goal-failed",
    store,
    commit: false,
    todoGenerationRunner: async (options) => {
      const outputPath = extractGenerationOutputPath(options.inputText ?? "");
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated failure TODO");
    },
    todoExecutionRunner: async (options) =>
      coordinatorResult(options, "Worker could not complete the generated TODO", {
        status: "failed",
        failedTasks: 1,
        completedTasks: 0,
        attemptedTasks: 1,
        error: "worker failed deterministically",
      }),
    reviewerRunner: async () =>
      reviewerResult("failed", "Goal failed", "The worker failure is unrecoverable without changing the goal.", [
        "Choose a different goal",
      ]),
    now: () => new Date("2026-06-25T12:30:00.000Z"),
  });

  assert.equal(result.state.status, "failed");
  assert.equal(result.state.phase, "complete");
  assert.equal(result.state.iterations.length, 1);
  assert.equal(result.state.iterations[0]?.workerResult?.status, "failed");
  assert.equal(result.state.iterations[0]?.reviewerResult?.decision, "failed");
  assert.match(result.state.completion?.reason ?? "", /unrecoverable/);
});

await withTempRoot("pi-goal-orchestrator-max-", async (tempRoot) => {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-max-iterations" });
  let generationCalls = 0;
  let executionCalls = 0;
  let reviewCalls = 0;

  const result = await runGoalLoop({
    goal: "Stop safely when max iterations are exhausted",
    cwd: tempRoot,
    goalRunId: "goal-max-iterations",
    store,
    maxIterations: 1,
    commit: false,
    todoGenerationRunner: async (options) => {
      generationCalls += 1;
      const outputPath = extractGenerationOutputPath(options.inputText ?? "");
      await writeFile(outputPath, sampleTodoMarkdown(1), "utf8");
      return coordinatorResult(options, "Generated TODO before max-iteration stop");
    },
    todoExecutionRunner: async (options) => {
      executionCalls += 1;
      return coordinatorResult(options, "Worker completed but reviewer still needed more");
    },
    reviewerRunner: async () => {
      reviewCalls += 1;
      return reviewerResult("incomplete", "Still incomplete", "The single allowed iteration was not enough.", [
        "More work that cannot be attempted because maxIterations=1",
      ]);
    },
    now: () => new Date("2026-06-25T12:40:00.000Z"),
  });

  assert.equal(result.state.status, "failed");
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.iterations.length, 1);
  assert.equal(generationCalls, 1);
  assert.equal(executionCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.match(result.state.completion?.reason ?? "", /maxIterations=1/);
  assert.equal(result.state.trace.at(-1)?.event, "max_iterations");
});

async function withTempRoot(prefix: string, fn: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function persistedDashboardSpec(goalRunId: string, originalGoal: string) {
  return createGoalSpecification({
    goalRunId,
    originalGoal,
    summary: "Persisted dashboard spec should drive implementation and review.",
    now: () => new Date("2026-06-25T12:06:00.000Z"),
    scopedRequirements: {
      inScope: [
        {
          id: "REQ-PERSIST",
          title: "Persisted dashboard slice",
          description: "Use the saved specification to implement the first dashboard slice.",
          priority: "must",
          acceptanceCriterionIds: ["AC-PERSIST"],
          milestoneIds: ["MS-PERSIST"],
        },
      ],
      outOfScope: [
        {
          id: "OOS-PERSIST",
          title: "Unrelated analytics expansion",
          description: "Do not add unrelated analytics outside the persisted dashboard scope.",
          priority: "wont",
          acceptanceCriterionIds: [],
          milestoneIds: [],
        },
      ],
      assumptions: ["The existing app shell can host the dashboard."],
      openQuestions: [],
    },
    milestones: [
      {
        id: "MS-PERSIST",
        title: "Persisted dashboard implementation",
        description: "Implement the saved dashboard scope and verification evidence.",
        requirementIds: ["REQ-PERSIST"],
        acceptanceCriterionIds: ["AC-PERSIST"],
        doneWhen: ["Generated TODOs and reviewer output cite the persisted spec IDs."],
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-PERSIST",
        description: "Implementation and review are evaluated against the saved dashboard requirement.",
        requirementIds: ["REQ-PERSIST"],
        verificationGateIds: ["VG-PERSIST"],
      },
    ],
    verificationGates: [
      {
        id: "VG-PERSIST",
        title: "Persisted spec verification",
        description: "Focused verification proves the saved spec drove the work.",
        required: true,
        command: "npm test -- dashboard",
        successCriteria: ["Spec-aware generation and review prompts include persisted IDs."],
      },
    ],
    definitionOfDone: {
      summary: "REQ-PERSIST, AC-PERSIST, and VG-PERSIST are satisfied.",
      requirementIds: ["REQ-PERSIST"],
      acceptanceCriterionIds: ["AC-PERSIST"],
      verificationGateIds: ["VG-PERSIST"],
      requiredArtifacts: ["Generated TODO", "Reviewer result"],
      notes: ["Do not rerun discovery if this spec is already persisted."],
    },
  });
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

function coordinatorResult(
  options: RunCoordinatorOptions,
  summary: string,
  overrides: Partial<CoordinatorResult> = {},
): CoordinatorResult {
  const cwd = path.resolve(options.cwd ?? os.tmpdir());
  const runId = options.runId ?? "child-run";
  const runDir = path.join(cwd, "tmp", "pi-long-task", runId);
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
    ...overrides,
  };
}

function reviewerResult(
  decision: "complete" | "incomplete" | "blocked" | "failed",
  summary: string,
  rationale: string,
  remainingWork: string[] = [],
) {
  return {
    assistantText: JSON.stringify({
      decision,
      complete: decision === "complete",
      summary,
      rationale,
      remainingWork,
    }),
    reviewerCostTotal: 0,
  };
}

function extractGenerationOutputPath(payloadText: string): string {
  const match = /Write the generated Pi Long Task-compatible TODO markdown to `([^`]+)`/.exec(payloadText);
  assert.ok(match?.[1], "expected output path in generation payload");
  return match[1];
}
