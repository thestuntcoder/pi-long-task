import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinator, type WorkerRunner } from "../src/coordinator.ts";
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
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-coordinator-test-"));
try {
  const calls: Array<{ taskId: string; attempt: number; previousAttempts?: string }> = [];
  const sequentialWorker: WorkerRunner = async (options) => {
    calls.push({ taskId: options.task.taskId, attempt: options.attempt, previousAttempts: options.previousAttempts });
    return outcomeFor(options, "done");
  };

  const sequential = await runCoordinator({
    inputText: "- First task\n- Second task",
    commit: false,
    cwd: tempRoot,
    runId: "sequential",
    workerRunner: sequentialWorker,
  });

  assert.equal(sequential.status, "done");
  assert.equal(sequential.totalTasks, 2);
  assert.equal(sequential.completedTasks, 2);
  assert.equal(sequential.attemptedTasks, 2);
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

  let plannerCalled = false;
  const planned = await runCoordinator({
    inputText: "Build a feature from an unstructured paragraph.",
    commit: false,
    cwd: tempRoot,
    runId: "planner",
    todoPlanner: async () => {
      plannerCalled = true;
      return generatedTodoMarkdown(["Planned task"]);
    },
    workerRunner: sequentialWorker,
  });
  assert.equal(plannerCalled, true);
  assert.equal(planned.status, "done");
  assert.equal(planned.completedTasks, 1);

  const retryCalls: Array<{ taskId: string; attempt: number; previousAttempts?: string }> = [];
  const retryWorker: WorkerRunner = async (options) => {
    retryCalls.push({ taskId: options.task.taskId, attempt: options.attempt, previousAttempts: options.previousAttempts });
    return outcomeFor(options, "partial");
  };

  const failed = await runCoordinator({
    inputText: "- Flaky task\n- Never reached",
    commit: true,
    cwd: tempRoot,
    runId: "retry-stop",
    workerRunner: retryWorker,
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.totalTasks, 2);
  assert.equal(failed.completedTasks, 0);
  assert.equal(failed.attemptedTasks, 3);
  assert.match(failed.error ?? "", /did not report done after 3 attempt/);
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
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
