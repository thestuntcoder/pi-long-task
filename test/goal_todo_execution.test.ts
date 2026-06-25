import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { createGoalLoopState, recordGeneratedTodo, startGoalIteration } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { GoalTodoExecutionError, runGoalTodoExecutionLongTask } from "../src/goal_todo_execution.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";

const baseTime = new Date("2026-06-25T10:00:00.000Z");

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-todo-execution-test-"));
try {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-execution" });
  let state = createGoalLoopState({
    goal: "Create an observable sample file",
    goalRunId: "goal-execution",
    cwd: tempRoot,
    now: () => baseTime,
  });
  await store.saveState(state);
  await store.initializeResult(state);
  await store.appendNewTraceEvents(0, state);

  state = startGoalIteration(state, { now: new Date("2026-06-25T10:00:01.000Z") });
  const iterationDir = store.iterationDir(1);
  await mkdir(iterationDir, { recursive: true });
  const generatedTodoPath = path.join(iterationDir, "TODO.md");
  await writeFile(generatedTodoPath, sampleTodoMarkdown(), "utf8");
  state = recordGeneratedTodo(
    state,
    1,
    { todoPath: generatedTodoPath, summary: "Generated one execution task" },
    { now: new Date("2026-06-25T10:00:02.000Z") },
  );
  await store.saveState(state);
  await store.appendNewTraceEvents(1, state);

  let runnerCalls = 0;
  let capturedOptions: RunCoordinatorOptions | undefined;
  const fakeLongTaskRunner = async (options: RunCoordinatorOptions): Promise<CoordinatorResult> => {
    runnerCalls += 1;
    capturedOptions = options;
    assert.equal(options.commit, false);
    assert.equal(options.goal, "Create an observable sample file");
    assert.match(options.runId ?? "", /goal-execution-todo-worker-01/);
    assert.match(options.inputText ?? "", /TODO 1 — Create sample file/);
    assert.equal(typeof options.taskTimeoutMs, "number");
    assert.ok((options.taskTimeoutMs ?? 0) > 0);
    options.onProgress?.({
      message: "Running sample worker task...",
      phase: "task_start",
      runId: options.runId ?? "worker-run",
      todoPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run", "TODO.md"),
      resultPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run", "TASK_RESULT.md"),
      workerCostTotal: 0,
      goal: options.goal,
      taskId: "1",
      title: "Create sample file",
    });

    return {
      status: "done",
      summary: "Pi Long Task completed 1/1 task(s).",
      message: "done",
      runId: options.runId ?? "worker-run",
      runDir: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run"),
      todoPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run", "TODO.md"),
      resultPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run", "TASK_RESULT.md"),
      taskResultPath: path.join(tempRoot, "tmp", "pi-long-task", options.runId ?? "worker-run", "TASK_RESULT.md"),
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
      workerCostTotal: 0.05,
      commit: false,
      goal: options.goal,
    };
  };

  const result = await runGoalTodoExecutionLongTask({
    state,
    store,
    cwd: tempRoot,
    longTaskRunner: fakeLongTaskRunner,
    commit: false,
    now: () => new Date("2026-06-25T10:00:03.000Z"),
  });

  assert.equal(runnerCalls, 1);
  assert.ok(capturedOptions);
  assert.equal(result.state.phase, "todo_executed");
  assert.equal(result.state.iterations[0]?.status, "todo_executed");
  assert.equal(result.iteration.workerResult?.status, "done");
  assert.equal(result.iteration.workerResult?.runId, "goal-execution-todo-worker-01");
  assert.equal(result.iteration.workerResult?.workerProgressPath, result.progressLogPath);
  assert.equal(result.childResult.workerCostTotal, 0.05);

  const loadedState = await store.loadState();
  assert.equal(loadedState.phase, "todo_executed");
  assert.equal(loadedState.iterations[0]?.workerResult?.completedTasks, 1);
  assert.equal(loadedState.iterations[0]?.workerResult?.taskResultPath, result.childResult.taskResultPath);

  const progressLog = await readFile(result.progressLogPath, "utf8");
  assert.match(progressLog, /Running sample worker task/);
  assert.match(progressLog, /"phase":"task_start"/);

  const traceText = await readFile(store.paths.tracePath, "utf8");
  assert.match(traceText, /"event":"todo_executed"/);

  const goalResult = await readFile(store.paths.resultPath, "utf8");
  assert.match(goalResult, /### Worker result/);
  assert.match(goalResult, /Worker progress log:/);

  const failureStore = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-execution-failure" });
  let failureState = createGoalLoopState({
    goal: "Surface worker execution errors",
    goalRunId: "goal-execution-failure",
    cwd: tempRoot,
    now: () => baseTime,
  });
  await failureStore.saveState(failureState);
  await failureStore.initializeResult(failureState);
  await failureStore.appendNewTraceEvents(0, failureState);
  failureState = startGoalIteration(failureState, { now: new Date("2026-06-25T10:01:01.000Z") });
  const failureIterationDir = failureStore.iterationDir(1);
  await mkdir(failureIterationDir, { recursive: true });
  const failureTodoPath = path.join(failureIterationDir, "TODO.md");
  await writeFile(failureTodoPath, sampleTodoMarkdown(), "utf8");
  failureState = recordGeneratedTodo(
    failureState,
    1,
    { todoPath: failureTodoPath, summary: "Generated failing execution task" },
    { now: new Date("2026-06-25T10:01:02.000Z") },
  );
  await failureStore.saveState(failureState);
  await failureStore.appendNewTraceEvents(1, failureState);

  let caught: unknown;
  try {
    await runGoalTodoExecutionLongTask({
      state: failureState,
      store: failureStore,
      cwd: tempRoot,
      longTaskRunner: async (options) => {
        options.onProgress?.({
          message: "Worker failed after starting",
          phase: "task_failed",
          runId: options.runId ?? "worker-run",
          todoPath: failureTodoPath,
          resultPath: path.join(failureIterationDir, "TASK_RESULT.md"),
          workerCostTotal: 0,
          goal: options.goal,
        });
        throw new Error("worker crashed");
      },
      commit: false,
      now: () => new Date("2026-06-25T10:01:03.000Z"),
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GoalTodoExecutionError);
  assert.match(caught.message, /worker crashed/);
  assert.equal(caught.workerResult?.status, "failed");
  const failureLoadedState = await failureStore.loadState();
  assert.equal(failureLoadedState.iterations[0]?.status, "failed");
  assert.match(failureLoadedState.iterations[0]?.workerResult?.error ?? "", /worker crashed/);
  const failureProgressLog = await readFile(caught.workerResult?.workerProgressPath ?? "", "utf8");
  assert.match(failureProgressLog, /Worker failed after starting/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function sampleTodoMarkdown(): string {
  return `# Pi Long Task TODO

## Progress

- [ ] TODO 1 — Create sample file

---

## TODO 1 — Create sample file

**Goal:** Create a small observable sample file.

**Status:**
- [ ] Write the sample file.

**Verify:**
- Confirm the sample file exists.

**Done when:**
- The sample file exists and the worker reports done.
`;
}
