import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, type CoordinatorResult, type RunCoordinatorOptions } from "../src/coordinator.ts";
import {
  createGoalLoopState,
  recordGeneratedTodo,
  recordReviewerResult,
  recordWorkerResult,
  startGoalIteration,
} from "../src/goal_loop.ts";
import { runGoalLoop } from "../src/goal_orchestrator.ts";
import { GoalReviewError, runGoalReviewSession } from "../src/goal_review.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { generatedTodoMarkdown, TodoGenerationError, validateTodoMarkdown } from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

const baseTime = new Date("2026-07-22T10:00:00.000Z");

test("an interruption between tasks preserves completed work and leaves later work pending", async () => {
  await withTempRoot("pi-regression-interrupt-", async (cwd) => {
    const abortController = new AbortController();
    const calls: string[] = [];

    const result = await runCoordinator({
      inputText: generatedTodoMarkdown(["Complete before interruption", "Remain pending"]),
      commit: false,
      cwd,
      runId: "interrupted-between-tasks",
      abortSignal: abortController.signal,
      workerRunner: async (options) => {
        calls.push(options.task.taskId);
        abortController.abort(new Error("stop after the first task"));
        return workerOutcome(options, "done");
      },
    });

    assert.deepEqual(calls, ["1"]);
    assert.equal(result.status, "partial");
    assert.equal(result.totalTasks, 2);
    assert.equal(result.completedTasks, 1);
    assert.equal(result.attemptedTasks, 1);
    assert.match(result.error ?? "", /run aborted/i);
    assert.deepEqual(
      result.remainingTasks.map((task) => [task.taskId, task.title]),
      [["2", "Remain pending"]],
    );

    const persistedTodo = await readFile(result.todoPath, "utf8");
    assert.deepEqual(
      parseTasks(persistedTodo).map((task) => [task.taskId, task.done]),
      [
        ["1", true],
        ["2", false],
      ],
    );
    const persistedResult = await readFile(result.taskResultPath, "utf8");
    assert.match(persistedResult, /## TODO 1 — Complete before interruption \(attempt 1\)/);
    assert.doesNotMatch(persistedResult, /## TODO 2 — Remain pending \(attempt/);
  });
});

test("TODO validation rejects malformed public document structure", () => {
  const valid = generatedTodoMarkdown(["Validate structure"]);
  const malformed = [
    {
      markdown: valid.replace("\n---\n", "\n"),
      error: /separator before task sections/,
    },
    {
      markdown: valid.replaceAll("TODO 1", "TODO 2"),
      error: /Expected TODO 1, found TODO 2/,
    },
    {
      markdown: valid.replace("**Status:**", "**Work:**"),
      error: /must include `\*\*Status:\*\*`/,
    },
  ];

  for (const sample of malformed) {
    assert.throws(() => validateTodoMarkdown(sample.markdown), sample.error);
  }
  assert.throws(() => validateTodoMarkdown("# Pi Long Task TODO\n"), TodoGenerationError);
});

test("malformed reviewer output is persisted as a failed review", async () => {
  await withTempRoot("pi-regression-reviewer-malformed-", async (cwd) => {
    const store = new GoalStateStore({ cwd, goalRunId: "malformed-review" });
    let state = reviewableState(cwd, "malformed-review");
    await store.saveState(state);
    await store.initializeResult(state);
    await store.appendNewTraceEvents(0, state);

    let caught: unknown;
    try {
      await runGoalReviewSession({
        state,
        cwd,
        store,
        reviewerRunner: async () => ({
          assistantText: "The work looks good, but this is not reviewer JSON.",
          reviewerSessionId: "malformed-reviewer-session",
        }),
        now: () => baseTime,
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof GoalReviewError);
    assert.equal(caught.reviewerResult?.decision, "failed");
    assert.match(caught.reviewerResult?.summary ?? "", /could not be parsed/i);

    state = await store.loadState();
    assert.equal(state.status, "failed");
    assert.equal(state.iterations[0]?.status, "failed");
    assert.equal(state.iterations[0]?.reviewerResult?.decision, "failed");
    assert.equal(state.iterations[0]?.reviewerResult?.reviewerSessionId, "malformed-reviewer-session");

    const rawOutput = await readFile(path.join(store.iterationDir(1), "REVIEW_RESULT_RAW.txt"), "utf8");
    assert.equal(rawOutput, "The work looks good, but this is not reviewer JSON.");
  });
});

test("a reviewed incomplete goal state resumes with the next iteration", async () => {
  await withTempRoot("pi-regression-resume-reviewed-", async (cwd) => {
    const goalRunId = "resume-reviewed";
    const store = new GoalStateStore({ cwd, goalRunId });
    let state = reviewableState(cwd, goalRunId);
    state = recordReviewerResult(
      state,
      1,
      {
        decision: "incomplete",
        complete: false,
        summary: "A follow-up pass is needed",
        rationale: "Verification evidence is still missing.",
        remainingWork: ["Add verification evidence"],
        reviewedAt: baseTime.toISOString(),
      },
      { now: baseTime },
    );
    assert.equal(state.phase, "reviewed");

    const generatedIterations: number[] = [];
    const executedInputs: string[] = [];
    const result = await runGoalLoop({
      initialState: state,
      cwd,
      store,
      commit: false,
      discoveryEntrypoint: "pi_long_task",
      todoGenerationRunner: async (options) => {
        generatedIterations.push(generatedIterations.length + 2);
        assert.match(options.inputText ?? "", /Add verification evidence/);
        const outputPath = generationOutputPath(options.inputText ?? "");
        await writeFile(outputPath, generatedTodoMarkdown(["Add verification evidence"]), "utf8");
        return coordinatorResult(options, "Generated resumed TODO");
      },
      todoExecutionRunner: async (options) => {
        executedInputs.push(options.inputText ?? "");
        return coordinatorResult(options, "Completed resumed TODO");
      },
      reviewerRunner: async () => ({
        assistantText: JSON.stringify({
          decision: "complete",
          complete: true,
          summary: "The resumed goal is complete",
          rationale: "The follow-up iteration added verification evidence.",
          remainingWork: [],
        }),
      }),
      now: () => new Date("2026-07-22T10:01:00.000Z"),
    });

    assert.deepEqual(generatedIterations, [2]);
    assert.equal(executedInputs.length, 1);
    assert.match(executedInputs[0] ?? "", /TODO 1 — Add verification evidence/);
    assert.equal(result.state.status, "done");
    assert.equal(result.state.iterations.length, 2);
    assert.equal(result.state.iterations[0]?.status, "reviewed_incomplete");
    assert.equal(result.state.iterations[1]?.status, "reviewed_complete");
  });
});

function reviewableState(cwd: string, goalRunId: string) {
  let state = createGoalLoopState({
    goal: "Finish a resumable goal safely",
    cwd,
    goalRunId,
    now: () => baseTime,
  });
  state = startGoalIteration(state, { now: baseTime });
  state = recordGeneratedTodo(
    state,
    1,
    { todoPath: path.join(cwd, "iteration-1", "TODO.md"), summary: "Generated first iteration" },
    { now: baseTime },
  );
  return recordWorkerResult(
    state,
    1,
    { status: "done", summary: "Completed first iteration", endedAt: baseTime.toISOString() },
    { now: baseTime },
  );
}

function workerOutcome(options: RunWorkerTaskOptions, status: string): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: baseTime.toISOString(),
    endedAt: baseTime.toISOString(),
    reportedStatus: status,
    done: status === "done",
    assistantText: `TASK_RESULT:\nstatus: ${status}\nsummary: test outcome\nchanges:\n- none\nverification:\n- focused test\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

function coordinatorResult(options: RunCoordinatorOptions, summary: string): CoordinatorResult {
  const runId = options.runId ?? "child-run";
  const runDir = path.join(options.cwd ?? "/tmp", "tmp", "pi-long-task", runId);
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

function generationOutputPath(payload: string): string {
  const match = /Write the generated Pi Long Task-compatible TODO markdown to `([^`]+)`/.exec(payload);
  assert.ok(match?.[1], "expected generated TODO output path");
  return match[1];
}

async function withTempRoot(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
