import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runCoordinator,
  runTodoPlanner,
  type CoordinatorProgressUpdate,
  type WorkerRunner,
} from "../src/coordinator.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

function outcomeFor(options: RunWorkerTaskOptions, status: string): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: `start-${options.task.taskId}-${options.attempt}`,
    endedAt: `end-${options.task.taskId}-${options.attempt}`,
    reportedStatus: status,
    done: status === "done",
    assistantText: `TASK_RESULT:\nstatus: ${status}\nsummary: ${options.task.taskId}/${options.attempt}\nchanges:\n- none\nverification:\n- not run\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

function assertProgressStatuses(
  updates: readonly CoordinatorProgressUpdate[],
  phase: CoordinatorProgressUpdate["phase"],
  taskId: string | undefined,
  expected: Array<[string, string, string]>,
): void {
  const update = updates.find((item) => item.phase === phase && (taskId === undefined || item.taskId === taskId));
  assert.ok(update, `expected ${phase}${taskId ? ` for TODO ${taskId}` : ""} progress update`);
  assert.deepEqual(
    update.taskProgress?.tasks.map((task) => [task.taskId, task.status, task.position]),
    expected,
  );
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-long-task-test-"));
try {
  const calls: Array<{ taskId: string; attempt: number; previousAttempts?: string }> = [];
  const sequentialWorker: WorkerRunner = async (options) => {
    calls.push({ taskId: options.task.taskId, attempt: options.attempt, previousAttempts: options.previousAttempts });
    return outcomeFor(options, "done");
  };

  const progressUpdates: CoordinatorProgressUpdate[] = [];
  const sequential = await runCoordinator({
    inputText: "- First task\n- Second task",
    commit: false,
    cwd: tempRoot,
    runId: "sequential",
    workerRunner: sequentialWorker,
    onProgress: (update) => progressUpdates.push(update),
  });

  assert.deepEqual(
    progressUpdates.map((update) => update.message),
    [
      "Creating TODO plan...",
      "Created TODO plan with 2 task(s).",
      "Running TODO 1 — First task...",
      "TODO 1 done.",
      "Running TODO 2 — Second task...",
      "TODO 2 done.",
      "Pi Long Task done.",
    ],
  );
  assertProgressStatuses(progressUpdates, "task_start", "1", [
    ["1", "current", "current"],
    ["2", "pending", "future"],
  ]);
  assertProgressStatuses(progressUpdates, "task_done", "1", [
    ["1", "completed", "current"],
    ["2", "pending", "future"],
  ]);
  assertProgressStatuses(progressUpdates, "task_start", "2", [
    ["1", "completed", "past"],
    ["2", "current", "current"],
  ]);
  assertProgressStatuses(progressUpdates, "task_done", "2", [
    ["1", "completed", "past"],
    ["2", "completed", "current"],
  ]);
  assertProgressStatuses(progressUpdates, "complete", undefined, [
    ["1", "completed", "past"],
    ["2", "completed", "past"],
  ]);
  assert.equal(sequential.status, "done");
  assert.equal(sequential.totalTasks, 2);
  assert.equal(sequential.completedTasks, 2);
  assert.equal(sequential.attemptedTasks, 2);
  assert.equal(sequential.failedTasks, 0);
  assert.equal(sequential.blockedTasks, 0);
  assert.equal(sequential.resultPath, sequential.taskResultPath);
  assert.equal(sequential.outcomes.length, 2);
  assert.deepEqual(sequential.commits, []);
  assert.match(sequential.message, /Pi Long Task: done/);
  assert.match(sequential.message, /Tasks: 2 completed, 0 failed, 0 blocked, 0 remaining \(2 total\)\./);
  assert.match(sequential.message, /Result file: /);
  assert.match(sequential.message, /TODO file: /);
  assert.deepEqual(
    calls.map((call) => `${call.taskId}:${call.attempt}`),
    ["1:1", "2:1"],
  );
  const sequentialTodo = await readFile(sequential.todoPath, "utf8");
  assert.deepEqual(
    parseTasks(sequentialTodo).map((task) => [task.taskId, task.done]),
    [
      ["1", true],
      ["2", true],
    ],
  );
  const sequentialResult = await readFile(sequential.taskResultPath, "utf8");
  assert.match(sequentialResult, /## TODO 1 — First task \(attempt 1\)/);
  assert.match(sequentialResult, /## TODO 2 — Second task \(attempt 1\)/);
  assert.match(sequentialResult, /status: done/);

  const costProgressUpdates: CoordinatorProgressUpdate[] = [];
  const costByTask = new Map([
    ["1", 0.125],
    ["2", 0.25],
  ]);
  const costRun = await runCoordinator({
    inputText: generatedTodoMarkdown(["Costed worker one", "Costed worker two"]),
    commit: false,
    cwd: tempRoot,
    runId: "worker-cost",
    workerRunner: async (options) => {
      const cost = costByTask.get(options.task.taskId) ?? 0;
      options.onEvent?.({
        type: "message_end",
        usageCostTotal: cost / 4,
        usageCostKey: `message:${options.task.taskId}:1`,
      });
      options.onEvent?.({
        type: "message_end",
        usageCostTotal: cost / 4,
        usageCostKey: `message:${options.task.taskId}:1`,
      });
      options.onEvent?.({
        type: "message_end",
        usageCostTotal: (cost * 3) / 4,
        usageCostKey: `message:${options.task.taskId}:2`,
      });
      return { ...outcomeFor(options, "done"), workerCostTotal: cost };
    },
    onProgress: (update) => costProgressUpdates.push(update),
  });
  assert.equal(costRun.workerCostTotal, 0.375);
  assert.deepEqual(
    costRun.outcomes.map((outcome) => outcome.workerCostTotal),
    [0.125, 0.25],
  );
  assert.equal(
    costProgressUpdates.filter((update) => update.phase === "worker_tool" && update.workerEventType === "message_end")
      .length,
    4,
  );
  assert.equal(
    costProgressUpdates.find((update) => update.phase === "task_done" && update.taskId === "1")?.workerCostTotal,
    0.125,
  );
  assert.equal(
    costProgressUpdates.find((update) => update.phase === "task_done" && update.taskId === "2")?.workerCostTotal,
    0.375,
  );
  assert.equal(costProgressUpdates.at(-1)?.workerCostTotal, 0.375);
  assert.match(costRun.message, /Worker spend: \$0\.38/);

  let plannerCalled = false;
  let plannerTimeoutMs: number | undefined;
  let plannerAbortSignal: AbortSignal | undefined;
  const planned = await runCoordinator({
    inputText: "Build a feature from an unstructured paragraph.",
    commit: false,
    cwd: tempRoot,
    runId: "planner",
    todoTimeoutMs: 12_345,
    todoPlanner: async (options) => {
      plannerCalled = true;
      plannerTimeoutMs = options.timeoutMs;
      plannerAbortSignal = options.abortSignal;
      return generatedTodoMarkdown(["Planned task"]);
    },
    workerRunner: sequentialWorker,
  });
  assert.equal(plannerCalled, true);
  assert.equal(plannerTimeoutMs, 12_345);
  assert.equal(plannerAbortSignal, undefined);
  assert.equal(planned.status, "done");
  assert.equal(planned.completedTasks, 1);

  const repairPlannerInputs: string[] = [];
  const repairPlannerRun = await runCoordinator({
    inputText: "Plan a task after repairing invalid planner output.",
    commit: false,
    cwd: tempRoot,
    runId: "planner-repair",
    todoPlanner: async (options) => {
      repairPlannerInputs.push(options.inputText);
      return repairPlannerInputs.length === 1
        ? "I forgot to output the required TODO markdown."
        : generatedTodoMarkdown(["Repaired planner task"]);
    },
    workerRunner: sequentialWorker,
  });
  assert.equal(repairPlannerRun.status, "done");
  assert.equal(repairPlannerRun.completedTasks, 1);
  assert.equal(repairPlannerInputs.length, 2);
  assert.match(repairPlannerInputs[1], /Validation\/extraction error:/);
  assert.match(repairPlannerInputs[1], /Could not extract valid Pi Long Task TODO markdown/);
  assert.match(repairPlannerInputs[1], /I forgot to output/);

  let invalidTwiceWorkerStarted = false;
  let invalidTwicePlannerCalls = 0;
  const invalidTwiceRun = await runCoordinator({
    inputText: "Plan a task but keep returning invalid planner output.",
    commit: false,
    cwd: tempRoot,
    runId: "planner-invalid-twice",
    todoPlanner: async () => {
      invalidTwicePlannerCalls += 1;
      return "still not TODO markdown";
    },
    workerRunner: async (options) => {
      invalidTwiceWorkerStarted = true;
      return outcomeFor(options, "done");
    },
  });
  assert.equal(invalidTwiceRun.status, "failed");
  assert.equal(invalidTwiceRun.attemptedTasks, 0);
  assert.equal(invalidTwiceRun.outcomes.length, 0);
  assert.equal(invalidTwicePlannerCalls, 2);
  assert.equal(invalidTwiceWorkerStarted, false);
  assert.match(invalidTwiceRun.error ?? "", /after one repair attempt/);

  const retryCalls: Array<{ taskId: string; attempt: number; previousAttempts?: string }> = [];
  const retryWorker: WorkerRunner = async (options) => {
    retryCalls.push({
      taskId: options.task.taskId,
      attempt: options.attempt,
      previousAttempts: options.previousAttempts,
    });
    return outcomeFor(options, "partial");
  };

  const failedProgressUpdates: CoordinatorProgressUpdate[] = [];
  const failed = await runCoordinator({
    inputText: "- Flaky task\n- Never reached",
    commit: true,
    cwd: tempRoot,
    runId: "retry-stop",
    workerRunner: retryWorker,
    onProgress: (update) => failedProgressUpdates.push(update),
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.totalTasks, 2);
  assert.equal(failed.completedTasks, 0);
  assert.equal(failed.attemptedTasks, 3);
  assert.match(failed.error ?? "", /did not report done after 3 attempt/);
  assertProgressStatuses(failedProgressUpdates, "task_failed", "1", [
    ["1", "failed", "current"],
    ["2", "pending", "future"],
  ]);
  assertProgressStatuses(failedProgressUpdates, "complete", undefined, [
    ["1", "failed", "current"],
    ["2", "pending", "future"],
  ]);
  assert.equal(failed.taskProgress.currentTaskId, "1");
  assert.deepEqual(
    retryCalls.map((call) => `${call.taskId}:${call.attempt}`),
    ["1:1", "1:2", "1:3"],
  );
  assert.equal(retryCalls[0].previousAttempts, undefined);
  assert.match(retryCalls[1].previousAttempts ?? "", /Attempt 1: status=partial/);
  assert.match(retryCalls[2].previousAttempts ?? "", /Attempt 2: status=partial/);

  const failedTodo = await readFile(failed.todoPath, "utf8");
  assert.deepEqual(
    parseTasks(failedTodo).map((task) => [task.taskId, task.done]),
    [
      ["1", false],
      ["2", false],
    ],
  );
  const failedResult = await readFile(failed.taskResultPath, "utf8");
  assert.equal((failedResult.match(/## TODO 1 — Flaky task/g) ?? []).length, 3);
  assert.equal((failedResult.match(/## TODO 2 — Never reached/g) ?? []).length, 0);

  const parentWorkerModel = { provider: "parent-provider", id: "parent-model" };
  const defaultModelCalls: Array<{
    model?: unknown;
    modelName?: string;
    thinkingLevel?: string;
  }> = [];
  const defaultModelRun = await runCoordinator({
    inputText: generatedTodoMarkdown(["Default parent model task"]),
    commit: false,
    cwd: tempRoot,
    runId: "default-parent-worker-model",
    workerModel: parentWorkerModel,
    workerRunner: async (options) => {
      defaultModelCalls.push({
        model: options.model,
        modelName: options.modelName,
        thinkingLevel: options.thinkingLevel,
      });
      return outcomeFor(options, "done");
    },
  });
  assert.equal(defaultModelRun.status, "done");
  assert.deepEqual(defaultModelCalls, [{ model: parentWorkerModel, modelName: undefined, thinkingLevel: "high" }]);

  let plannerFactoryOptions:
    | { model?: unknown; modelName?: string; thinkingLevel?: string; tools?: readonly string[] }
    | undefined;
  let plannerDisposed = false;
  const plannedText = await runTodoPlanner({
    inputText: "Plan a parent-default model task.",
    cwd: tempRoot,
    runDir: path.join(tempRoot, "planner-parent-default"),
    thinkingLevel: "xhigh",
    model: parentWorkerModel,
    sessionFactory: async (options) => {
      plannerFactoryOptions = {
        model: options.model,
        modelName: options.modelName,
        thinkingLevel: options.thinkingLevel,
        tools: options.tools,
      };
      return {
        session: {
          async prompt() {},
          getLastAssistantText: () => generatedTodoMarkdown(["Planned parent default"]),
          subscribe: () => () => {},
          dispose: () => {
            plannerDisposed = true;
          },
        },
      };
    },
  });
  assert.match(plannedText, /TODO 1 — Planned parent default/);
  assert.deepEqual(plannerFactoryOptions, {
    model: parentWorkerModel,
    modelName: undefined,
    thinkingLevel: "xhigh",
    tools: [],
  });
  assert.equal(plannerDisposed, true);

  const plannerRepairPrompts: string[] = [];
  let plannerRepairDisposed = false;
  const plannerRepairText = await runTodoPlanner({
    inputText: "Plan with a first invalid model response.",
    cwd: tempRoot,
    runDir: path.join(tempRoot, "planner-repair-session"),
    thinkingLevel: "xhigh",
    sessionFactory: async () => ({
      session: {
        async prompt(text) {
          plannerRepairPrompts.push(text);
        },
        getLastAssistantText: () =>
          plannerRepairPrompts.length === 1
            ? "This is commentary, not TODO markdown."
            : generatedTodoMarkdown(["Session repaired planner task"]),
        subscribe: () => () => {},
        dispose: () => {
          plannerRepairDisposed = true;
        },
      },
    }),
  });
  assert.match(plannerRepairText, /TODO 1 — Session repaired planner task/);
  assert.equal(plannerRepairPrompts.length, 2);
  assert.match(plannerRepairPrompts[1], /Validation\/extraction error:/);
  assert.match(plannerRepairPrompts[1], /This is commentary/);
  assert.equal(plannerRepairDisposed, true);

  let timeoutPlannerDisposed = false;
  let timeoutPlannerAbortCalls = 0;
  let resolveTimeoutPromptStarted: (() => void) | undefined;
  const timeoutPromptStarted = new Promise<void>((resolve) => {
    resolveTimeoutPromptStarted = resolve;
  });
  const timeoutPlannerPromise = runTodoPlanner({
    inputText: "Plan a task that hangs.",
    cwd: tempRoot,
    runDir: path.join(tempRoot, "planner-timeout"),
    thinkingLevel: "xhigh",
    timeoutMs: 10,
    gracefulShutdownMs: 0,
    sessionFactory: async () => ({
      session: {
        async prompt() {
          resolveTimeoutPromptStarted?.();
          await new Promise<void>(() => {});
        },
        subscribe: () => () => {},
        abort: () => {
          timeoutPlannerAbortCalls += 1;
        },
        dispose: () => {
          timeoutPlannerDisposed = true;
        },
      },
    }),
  });
  await timeoutPromptStarted;
  await assert.rejects(timeoutPlannerPromise, /TODO planner timed out: session prompt exceeded 0\.010s timeout/);
  assert.equal(timeoutPlannerAbortCalls, 1);
  assert.equal(timeoutPlannerDisposed, true);

  const plannerAbortController = new AbortController();
  let abortedPlannerDisposed = false;
  let abortedPlannerAbortCalls = 0;
  let resolveAbortPromptStarted: (() => void) | undefined;
  const abortPromptStarted = new Promise<void>((resolve) => {
    resolveAbortPromptStarted = resolve;
  });
  const abortedPlannerPromise = runTodoPlanner({
    inputText: "Plan a task that will be aborted.",
    cwd: tempRoot,
    runDir: path.join(tempRoot, "planner-abort"),
    thinkingLevel: "xhigh",
    abortSignal: plannerAbortController.signal,
    timeoutMs: 1_000,
    sessionFactory: async () => ({
      session: {
        async prompt() {
          resolveAbortPromptStarted?.();
          await new Promise<void>(() => {});
        },
        subscribe: () => () => {},
        abort: () => {
          abortedPlannerAbortCalls += 1;
        },
        dispose: () => {
          abortedPlannerDisposed = true;
        },
      },
    }),
  });
  await abortPromptStarted;
  plannerAbortController.abort(new Error("stop planning"));
  await assert.rejects(abortedPlannerPromise, /TODO planner aborted: stop planning/);
  assert.equal(abortedPlannerAbortCalls, 1);
  assert.equal(abortedPlannerDisposed, true);

  let noTextPlannerDisposed = false;
  await assert.rejects(
    runTodoPlanner({
      inputText: "Plan a task with no answer.",
      cwd: tempRoot,
      runDir: path.join(tempRoot, "planner-no-text"),
      thinkingLevel: "xhigh",
      timeoutMs: 100,
      sessionFactory: async () => ({
        session: {
          async prompt() {},
          subscribe: () => () => {},
          dispose: () => {
            noTextPlannerDisposed = true;
          },
        },
      }),
    }),
    /TODO planner did not return assistant text\./,
  );
  assert.equal(noTextPlannerDisposed, true);

  const configuredCalls: Array<{
    attempt: number;
    model?: unknown;
    modelName?: string;
    taskTimeoutSeconds?: number;
    maxBashTimeoutSeconds: number;
    thinkingLevel?: string;
  }> = [];
  const configured = await runCoordinator({
    inputText: `# Pi Long Task TODO

Worker provider: test-provider
Worker model: test-model
Worker attempts: 2
Worker timeout: 7m
Max bash timeout: 42s

## Progress

- [ ] TODO 1 — Configured worker task

---

## TODO 1 — Configured worker task

**Goal:** Verify worker runtime config is passed through.

**Status:**
- [ ] Run configured worker

**Verify:** Focused assertion.

**Done when:** Config was observed.
`,
    commit: false,
    cwd: tempRoot,
    runId: "configured-worker-runtime",
    workerModel: parentWorkerModel,
    workerRunner: async (options) => {
      configuredCalls.push({
        attempt: options.attempt,
        model: options.model,
        modelName: options.modelName,
        taskTimeoutSeconds: options.taskTimeoutSeconds,
        maxBashTimeoutSeconds: options.maxBashTimeoutSeconds,
        thinkingLevel: options.thinkingLevel,
      });
      return outcomeFor(options, "partial");
    },
  });
  assert.equal(configured.status, "failed");
  assert.deepEqual(
    configuredCalls.map((call) => call.attempt),
    [1, 2],
  );
  assert.deepEqual(
    configuredCalls.map((call) => call.model),
    [undefined, undefined],
  );
  assert.deepEqual(
    configuredCalls.map((call) => call.modelName),
    ["test-provider/test-model", "test-provider/test-model"],
  );
  assert.deepEqual(
    configuredCalls.map((call) => call.taskTimeoutSeconds),
    [420, 420],
  );
  assert.deepEqual(
    configuredCalls.map((call) => call.maxBashTimeoutSeconds),
    [42, 42],
  );
  assert.deepEqual(
    configuredCalls.map((call) => call.thinkingLevel),
    ["high", "high"],
  );

  const blockedProgressUpdates: CoordinatorProgressUpdate[] = [];
  const blocked = await runCoordinator({
    inputText: generatedTodoMarkdown(["Blocked task"]),
    commit: false,
    cwd: tempRoot,
    runId: "blocked",
    workerRunner: async (options) => outcomeFor(options, "blocked"),
    maxAttemptsPerTask: 1,
    onProgress: (update) => blockedProgressUpdates.push(update),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedTasks, 1);
  assert.equal(blocked.failedTasks, 0);
  assertProgressStatuses(blockedProgressUpdates, "task_blocked", "1", [["1", "blocked", "current"]]);
  assertProgressStatuses(blockedProgressUpdates, "complete", undefined, [["1", "blocked", "current"]]);
  assert.equal(blocked.taskProgress.currentTaskId, "1");
  assert.match(blocked.message, /Pi Long Task: blocked/);
  assert.match(blocked.message, /Remaining tasks:\n- TODO 1 — Blocked task \(blocked\)/);

  const workerToolUpdates: CoordinatorProgressUpdate[] = [];
  const workerToolRun = await runCoordinator({
    inputText: generatedTodoMarkdown(["Emit worker tool progress"]),
    commit: false,
    cwd: tempRoot,
    runId: "worker-tool-progress",
    workerRunner: async (options) => {
      options.onEvent?.({ type: "tool_execution_start", toolName: "bash" });
      options.onEvent?.({ type: "tool_execution_end", toolName: "bash", isError: true });
      return outcomeFor(options, "done");
    },
    onProgress: (update) => workerToolUpdates.push(update),
  });
  assert.equal(workerToolRun.status, "done");
  const taskStart = workerToolUpdates.find((update) => update.phase === "task_start");
  assert.deepEqual(taskStart?.currentTask, {
    taskId: "1",
    title: "Emit worker tool progress",
    status: "in_progress",
  });
  assert.deepEqual(taskStart?.subtasks, [{ text: "Complete emit worker tool progress", status: "in_progress" }]);
  assert.deepEqual(
    taskStart?.taskProgress?.tasks.map((task) => [task.taskId, task.status, task.position]),
    [["1", "current", "current"]],
  );

  const bashStart = workerToolUpdates.find(
    (update) => update.phase === "worker_tool" && update.workerEventType === "tool_execution_start",
  );
  assert.equal(bashStart?.toolName, "bash");
  assert.equal(bashStart?.status, "started");
  assert.equal(bashStart?.currentTask?.status, "in_progress");
  assert.deepEqual(bashStart?.subtasks, [{ text: "Complete emit worker tool progress", status: "in_progress" }]);
  const bashEnd = workerToolUpdates.find(
    (update) => update.phase === "worker_tool" && update.workerEventType === "tool_execution_end",
  );
  assert.equal(bashEnd?.toolName, "bash");
  assert.equal(bashEnd?.status, "failed");
  assert.equal(bashEnd?.isError, true);
  const taskDone = workerToolUpdates.find((update) => update.phase === "task_done");
  assert.equal(taskDone?.currentTask?.status, "done");
  assert.deepEqual(taskDone?.subtasks, [{ text: "Complete emit worker tool progress", status: "done" }]);
  assert.equal(taskDone?.taskProgress?.summary.completedPercent, 100);
  assert.equal(workerToolRun.taskProgress.summary.completedTasks, 1);

  const commitSkipUpdates: CoordinatorProgressUpdate[] = [];
  const commitSkipped = await runCoordinator({
    inputText: generatedTodoMarkdown(["Skip commit for failed outcome"]),
    commit: true,
    cwd: tempRoot,
    runId: "commit-skip-progress",
    workerRunner: async (options) => outcomeFor(options, "failed"),
    maxAttemptsPerTask: 1,
    onProgress: (update) => commitSkipUpdates.push(update),
  });
  assert.equal(commitSkipped.status, "failed");
  const failedUpdate = commitSkipUpdates.find((update) => update.phase === "task_failed");
  assert.equal(failedUpdate?.commitSkipped, "outcome is not eligible for commit");
  assert.equal(failedUpdate?.currentTask?.status, "failed");
  assert.deepEqual(failedUpdate?.subtasks, [{ text: "Complete skip commit for failed outcome", status: "failed" }]);
  assert.match(failedUpdate?.message ?? "", /commit skipped: outcome is not eligible for commit/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
