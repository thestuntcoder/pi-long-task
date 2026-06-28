import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { createGoalLoopState } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { createGoalSpecification } from "../src/goal_spec.ts";
import { buildGoalTodoGenerationTaskPayload, runGoalTodoGenerationLongTask } from "../src/goal_todo_generation.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";
import { validateTodoMarkdown } from "../src/todo_generator.ts";

const baseTime = new Date("2026-06-25T09:00:00.000Z");

const payload = buildGoalTodoGenerationTaskPayload({
  state: {
    goal: "Ship safe goal-loop TODO generation",
    goalRunId: "payload-test",
    limits: { minIterations: 1, maxIterations: 50, timeoutMs: 1, iterationTimeoutMs: 1, reviewerTimeoutMs: 1 },
  },
  iteration: 1,
  outputPath: "/tmp/generated/TODO.md",
});
assert.match(payload, /^# Pi Long Task TODO/);
assert.match(payload, /Only generate TODO markdown/);
assert.match(payload, /Write the generated Pi Long Task-compatible TODO markdown to `\/tmp\/generated\/TODO\.md`/);
assert.match(payload, /iteration 1 of at least 1 required iteration/);
validateTodoMarkdown(payload);

const specification = createGoalSpecification({
  goalRunId: "goal-generation",
  originalGoal: "Add a sample settings page with tests",
  summary: "Deliver a scoped settings page that guides users through required settings.",
  now: () => baseTime,
  scopedRequirements: {
    inScope: [
      {
        id: "REQ-1",
        title: "Guided onboarding checklist",
        description: "Create an onboarding checklist that moves users through required setup steps.",
        priority: "must",
        acceptanceCriterionIds: ["AC-1"],
        milestoneIds: ["MS-1"],
        source: "Product Owner",
      },
    ],
    outOfScope: [
      {
        id: "OOS-1",
        title: "Billing integrations",
        description: "Do not add billing integrations during onboarding implementation.",
        priority: "wont",
        acceptanceCriterionIds: [],
        milestoneIds: [],
      },
    ],
    assumptions: ["Existing routes can host the onboarding flow."],
    openQuestions: ["Which analytics event names should be used?"],
  },
  milestones: [
    {
      id: "MS-1",
      title: "Onboarding workflow implementation",
      description: "Implement the guided onboarding workflow and connect it to existing navigation.",
      requirementIds: ["REQ-1"],
      acceptanceCriterionIds: ["AC-1"],
      doneWhen: ["Users can complete each required onboarding step."],
    },
  ],
  acceptanceCriteria: [
    {
      id: "AC-1",
      description: "Users can see, complete, and revisit onboarding checklist steps.",
      requirementIds: ["REQ-1"],
      verificationGateIds: ["VG-1"],
    },
  ],
  verificationGates: [
    {
      id: "VG-1",
      title: "Focused onboarding tests",
      description: "Run focused automated tests for onboarding checklist behavior.",
      required: true,
      command: "npm test -- onboarding",
      successCriteria: ["Focused onboarding tests pass."],
    },
  ],
  definitionOfDone: {
    summary: "REQ-1 and AC-1 are implemented and VG-1 passes.",
    requirementIds: ["REQ-1"],
    acceptanceCriterionIds: ["AC-1"],
    verificationGateIds: ["VG-1"],
    requiredArtifacts: ["Updated onboarding implementation", "Focused test evidence"],
    notes: ["Keep OOS-1 out of scope."],
  },
});

const payloadWithSpec = buildGoalTodoGenerationTaskPayload({
  state: {
    goal: "Add a sample settings page with tests",
    goalRunId: "goal-generation",
    limits: { minIterations: 1, maxIterations: 50, timeoutMs: 1, iterationTimeoutMs: 1, reviewerTimeoutMs: 1 },
  },
  iteration: 1,
  outputPath: "/tmp/generated/TODO.md",
  goalSpecification: specification,
  goalSpecificationPath: "/tmp/goal/GOAL_SPEC.json",
});
assert.match(payloadWithSpec, /Persisted goal specification \(source of truth for implementation TODOs\)/);
assert.match(payloadWithSpec, /REQ-1/);
assert.match(payloadWithSpec, /MS-1/);
assert.match(payloadWithSpec, /AC-1/);
assert.match(payloadWithSpec, /VG-1/);
assert.match(payloadWithSpec, /derive implementation TODOs from that specification/i);
validateTodoMarkdown(payloadWithSpec);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-todo-generation-test-"));
try {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-generation" });
  const initialState = createGoalLoopState({
    goal: "Add a sample settings page with tests",
    goalRunId: "goal-generation",
    cwd: tempRoot,
    now: () => baseTime,
  });
  await store.saveState(initialState);
  await store.initializeResult(initialState);
  await store.appendNewTraceEvents(0, initialState);
  await store.saveGoalSpecification(specification);

  let runnerCalls = 0;
  let capturedOptions: RunCoordinatorOptions | undefined;
  const fakeLongTaskRunner = async (options: RunCoordinatorOptions): Promise<CoordinatorResult> => {
    runnerCalls += 1;
    capturedOptions = options;
    assert.equal(options.commit, false);
    assert.equal(options.goal, "Add a sample settings page with tests");
    assert.match(options.runId ?? "", /goal-generation-todo-generation-01/);
    assert.match(options.inputText ?? "", /do not implement/i);
    assert.match(options.inputText ?? "", /Persisted goal specification/);
    assert.match(options.inputText ?? "", /REQ-1/);
    assert.match(options.inputText ?? "", /MS-1/);
    assert.match(options.inputText ?? "", /AC-1/);
    assert.match(options.inputText ?? "", /VG-1/);

    const outputPath = extractOutputPath(options.inputText ?? "");
    await writeFile(
      outputPath,
      `# Pi Long Task TODO

## Progress

- [ ] TODO 1 — Add settings page
- [ ] TODO 2 — Test settings page

---

## TODO 1 — Add settings page

**Goal:** Add the sample settings page.

**Status:**
- [ ] Create the settings page UI.

**Verify:**
- Run focused UI checks.

**Done when:**
- The settings page is implemented.

## TODO 2 — Test settings page

**Goal:** Add focused tests for the sample settings page.

**Status:**
- [ ] Add tests for expected settings page behavior.

**Verify:**
- Run the focused test file.

**Done when:**
- Tests cover the page behavior and pass.
`,
      "utf8",
    );

    return {
      status: "done",
      summary: "Generated implementation TODO",
      message: "done",
      runId: options.runId ?? "child-run",
      runDir: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "child-run"),
      todoPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "child-run", "TODO.md"),
      resultPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "child-run", "TASK_RESULT.md"),
      taskResultPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "child-run", "TASK_RESULT.md"),
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
      commit: false,
      goal: options.goal,
    };
  };

  const result = await runGoalTodoGenerationLongTask({
    state: initialState,
    store,
    cwd: tempRoot,
    longTaskRunner: fakeLongTaskRunner,
    now: () => new Date("2026-06-25T09:00:01.000Z"),
  });

  assert.equal(runnerCalls, 1);
  assert.ok(capturedOptions);
  assert.equal(result.state.phase, "todo_generated");
  assert.equal(result.state.iterations[0]?.status, "todo_generated");
  assert.equal(result.taskCount, 2);
  assert.equal(result.iteration.generatedTodo?.todoPath, result.todoPath);
  assert.equal(result.iteration.generatedTodo?.payloadPath, result.payloadPath);
  assert.equal(result.iteration.generatedTodo?.generatorRunId, "goal-generation-todo-generation-01");
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  validateTodoMarkdown(result.todoMarkdown);

  const storedTodo = await readFile(result.todoPath, "utf8");
  assert.equal(storedTodo, result.todoMarkdown);
  assert.match(storedTodo, /Long task goal: Add a sample settings page with tests/);
  assert.match(storedTodo, /Persisted goal specification:/);
  assert.match(storedTodo, /Implementation TODOs must trace to requirements: REQ-1/);
  assert.match(storedTodo, /Implementation TODOs must satisfy acceptance criteria: AC-1/);
  assert.match(storedTodo, /Required verification gates: VG-1/);
  assert.match(storedTodo, /Implementation TODOs should be sequenced by milestones: MS-1/);

  const loadedState = await store.loadState();
  assert.equal(loadedState.phase, "todo_generated");
  assert.equal(loadedState.iterations[0]?.generatedTodo?.contentHash, result.contentHash);

  const traceText = await readFile(store.paths.tracePath, "utf8");
  assert.match(traceText, /"event":"iteration_started"/);
  assert.match(traceText, /"event":"todo_generated"/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function extractOutputPath(payloadText: string): string {
  const match = /Write the generated Pi Long Task-compatible TODO markdown to `([^`]+)`/.exec(payloadText);
  assert.ok(match?.[1], "expected output path in generation payload");
  return match[1];
}
