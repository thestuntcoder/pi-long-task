import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { createGoalLoopState } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { buildGoalTodoGenerationTaskPayload, runGoalTodoGenerationLongTask } from "../src/goal_todo_generation.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";
import { validateTodoMarkdown } from "../src/todo_generator.ts";

const baseTime = new Date("2026-06-25T09:00:00.000Z");

const payload = buildGoalTodoGenerationTaskPayload({
  state: { goal: "Ship safe goal-loop TODO generation", goalRunId: "payload-test" },
  iteration: 1,
  outputPath: "/tmp/generated/TODO.md",
});
assert.match(payload, /^# Pi Long Task TODO/);
assert.match(payload, /Only generate TODO markdown/);
assert.match(payload, /Write the generated Pi Long Task-compatible TODO markdown to `\/tmp\/generated\/TODO\.md`/);
validateTodoMarkdown(payload);

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

  let runnerCalls = 0;
  let capturedOptions: RunCoordinatorOptions | undefined;
  const fakeLongTaskRunner = async (options: RunCoordinatorOptions): Promise<CoordinatorResult> => {
    runnerCalls += 1;
    capturedOptions = options;
    assert.equal(options.commit, false);
    assert.equal(options.goal, "Add a sample settings page with tests");
    assert.match(options.runId ?? "", /goal-generation-todo-generation-01/);
    assert.match(options.inputText ?? "", /do not implement/i);

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
