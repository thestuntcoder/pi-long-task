import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runCoordinator, type CoordinatorResult, type RunCoordinatorOptions } from "../src/coordinator.ts";
import {
  createGoalLoopState,
  recordGeneratedTodo,
  recordReviewerResult,
  recordWorkerResult,
  startGoalIteration,
} from "../src/goal_loop.ts";
import { runGoalLoop } from "../src/goal_orchestrator.ts";
import { GoalReviewError, runGoalReviewerSession, runGoalReviewSession } from "../src/goal_review.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { generatedTodoMarkdown, TodoGenerationError, validateTodoMarkdown } from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

const baseTime = new Date("2026-07-22T10:00:00.000Z");
const execFileAsync = promisify(execFile);

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

test("escaped worker errors retain planned task counts and active-task evidence", async () => {
  await withTempRoot("pi-regression-worker-throw-", async (cwd) => {
    const result = await runCoordinator({
      inputText: generatedTodoMarkdown(["Throw in worker", "Remain known"]),
      commit: false,
      cwd,
      runId: "worker-throw",
      workerRunner: async () => {
        throw new Error("worker boundary exploded");
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.totalTasks, 2);
    assert.equal(result.completedTasks, 0);
    assert.equal(result.attemptedTasks, 1);
    assert.deepEqual(
      result.remainingTasks.map((task) => task.taskId),
      ["1", "2"],
    );
    const persisted = await readFile(result.taskResultPath, "utf8");
    assert.match(persisted, /TODO 1 — Throw in worker \(attempt 1\) failed: worker boundary exploded/);
  });
});

test("retry commits retain the task's original protected dirty-path baseline", async () => {
  await withTempRoot("pi-regression-retry-commit-", async (cwd) => {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
    await writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd });

    const result = await runCoordinator({
      inputText: generatedTodoMarkdown(["Complete across retries"]),
      commit: true,
      cwd,
      runId: "retry-commit-baseline",
      maxAttemptsPerTask: 2,
      workerRunner: async (options) => {
        await appendFile(path.join(cwd, "tracked.txt"), `attempt-${options.attempt}\n`, "utf8");
        return workerOutcome(options, options.attempt === 1 ? "partial" : "done");
      },
    });
    assert.equal(result.status, "done");
    assert.ok(result.commits.some((commit) => commit.hash));
    const { stdout } = await execFileAsync("git", ["show", "HEAD:tracked.txt"], { cwd });
    assert.equal(stdout, "base\nattempt-1\nattempt-2\n");
  });
});

test("task completion is not persisted when durable attempt evidence cannot be appended", async () => {
  await withTempRoot("pi-regression-durable-order-", async (cwd) => {
    const runId = "durable-order";
    const resultPath = path.join(cwd, "tmp", "pi-long-task", runId, "TASK_RESULT.md");
    const result = await runCoordinator({
      inputText: generatedTodoMarkdown(["Require durable evidence"]),
      commit: false,
      cwd,
      runId,
      workerRunner: async (options) => {
        await unlink(resultPath);
        await mkdir(resultPath);
        return workerOutcome(options, "done");
      },
    });
    assert.equal(result.status, "failed");
    const todo = await readFile(result.todoPath, "utf8");
    assert.equal(parseTasks(todo)[0]?.done, false);
  });
});

test("an abort arriving with the final trustworthy completion still reports done", async () => {
  await withTempRoot("pi-regression-final-abort-", async (cwd) => {
    const abortController = new AbortController();
    const result = await runCoordinator({
      inputText: generatedTodoMarkdown(["Finish as abort arrives"]),
      commit: false,
      cwd,
      runId: "final-abort",
      abortSignal: abortController.signal,
      workerRunner: async (options) => {
        abortController.abort();
        return workerOutcome(options, "done");
      },
    });
    assert.equal(result.status, "done");
    assert.equal(result.completedTasks, 1);
    assert.equal(result.error, undefined);
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

test("reviewer session errors cannot be overridden by parseable completion text", async () => {
  await withTempRoot("pi-regression-reviewer-error-", async (cwd) => {
    const store = new GoalStateStore({ cwd, goalRunId: "reviewer-error" });
    const state = reviewableState(cwd, "reviewer-error");
    await store.saveState(state);
    await store.initializeResult(state);
    await store.appendNewTraceEvents(0, state);

    await assert.rejects(
      runGoalReviewSession({
        state,
        cwd,
        store,
        reviewerRunner: async () => ({
          assistantText: JSON.stringify({
            decision: "complete",
            complete: true,
            summary: "stale completion",
            rationale: "must not be trusted",
            remainingWork: [],
          }),
          timedOut: true,
          error: "review transport timeout",
        }),
        now: () => baseTime,
      }),
      GoalReviewError,
    );
    const persisted = await store.loadState();
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.iterations[0]?.reviewerResult?.decision, "failed");
  });
});

test("reviewer cancellation is bounded when prompt and abort never settle it", async () => {
  const abortController = new AbortController();
  let abortCalls = 0;
  let disposeCalls = 0;
  const resultPromise = runGoalReviewerSession({
    prompt: "review",
    cwd: "/tmp",
    timeoutMs: 10_000,
    abortSignal: abortController.signal,
    sessionFactory: async () => ({
      session: {
        subscribe: () => () => {},
        prompt: async () => new Promise<void>(() => {}),
        abort: () => {
          abortCalls += 1;
        },
        dispose: () => {
          disposeCalls += 1;
        },
      },
    }),
  });
  setTimeout(() => abortController.abort(new Error("stop review")), 5);
  const result = await Promise.race([
    resultPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("review cancellation hung")), 100)),
  ]);
  assert.equal(result.aborted, true);
  assert.equal(abortCalls, 1);
  assert.equal(disposeCalls, 1);
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

test("goal loop resumes todo_generated and todo_executed phases without rewriting artifacts", async () => {
  await withTempRoot("pi-regression-resume-phases-", async (cwd) => {
    const generatedRunId = "resume-generated";
    const generatedStore = new GoalStateStore({ cwd, goalRunId: generatedRunId });
    let generatedState = createGoalLoopState({
      goal: "Resume generated work",
      cwd,
      goalRunId: generatedRunId,
      now: () => baseTime,
    });
    generatedState = startGoalIteration(generatedState, { now: baseTime });
    const todoPath = path.join(generatedStore.iterationDir(1), "TODO.md");
    await mkdir(path.dirname(todoPath), { recursive: true });
    await writeFile(todoPath, generatedTodoMarkdown(["Execute resumed TODO"]), "utf8");
    generatedState = recordGeneratedTodo(
      generatedState,
      1,
      { todoPath, summary: "already generated" },
      { now: baseTime },
    );
    await generatedStore.saveState(generatedState);
    await generatedStore.initializeResult(generatedState);
    await generatedStore.appendNewTraceEvents(0, generatedState);
    await appendFile(generatedStore.paths.resultPath, "PRESERVE-ME\n", "utf8");

    let generationCalls = 0;
    let executionCalls = 0;
    const generatedResult = await runGoalLoop({
      initialState: generatedState,
      cwd,
      store: generatedStore,
      commit: false,
      todoGenerationRunner: async () => {
        generationCalls += 1;
        throw new Error("generation must not repeat");
      },
      todoExecutionRunner: async (options) => {
        executionCalls += 1;
        return coordinatorResult(options, "resumed execution complete");
      },
      reviewerRunner: async () => ({
        assistantText: JSON.stringify({
          decision: "complete",
          complete: true,
          summary: "resumed phase complete",
          rationale: "execution and review completed",
          remainingWork: [],
        }),
      }),
      now: () => new Date("2026-07-22T10:02:00.000Z"),
    });
    assert.equal(generationCalls, 0);
    assert.equal(executionCalls, 1);
    assert.equal(generatedResult.state.status, "done");
    assert.match(await readFile(generatedStore.paths.resultPath, "utf8"), /PRESERVE-ME/);
    const trace = await readFile(generatedStore.paths.tracePath, "utf8");
    assert.equal((trace.match(/"event":"goal_received"/g) ?? []).length, 1);

    const executedRunId = "resume-executed";
    const executedStore = new GoalStateStore({ cwd, goalRunId: executedRunId });
    const executedState = reviewableState(cwd, executedRunId);
    await executedStore.saveState(executedState);
    await executedStore.initializeResult(executedState);
    await executedStore.appendNewTraceEvents(0, executedState);
    let repeatedExecution = 0;
    const executedResult = await runGoalLoop({
      initialState: executedState,
      cwd,
      store: executedStore,
      commit: false,
      todoExecutionRunner: async () => {
        repeatedExecution += 1;
        throw new Error("execution must not repeat");
      },
      reviewerRunner: async () => ({
        assistantText: JSON.stringify({
          decision: "complete",
          complete: true,
          summary: "review resumed",
          rationale: "persisted execution was sufficient",
          remainingWork: [],
        }),
      }),
      now: () => new Date("2026-07-22T10:03:00.000Z"),
    });
    assert.equal(repeatedExecution, 0);
    assert.equal(executedResult.state.status, "done");
  });
});

test("active goal cancellation and iteration deadlines return structured terminal results", async () => {
  await withTempRoot("pi-regression-goal-terminal-", async (cwd) => {
    const abortController = new AbortController();
    const cancelled = await runGoalLoop({
      goal: "Cancel during generation",
      cwd,
      goalRunId: "cancel-during-generation",
      abortSignal: abortController.signal,
      todoGenerationRunner: async () => {
        abortController.abort(new Error("cancel child"));
        throw new Error("child observed cancellation");
      },
      now: () => baseTime,
    });
    assert.equal(cancelled.state.status, "cancelled");
    assert.match(cancelled.state.completion?.reason ?? "", /aborted|cancel/i);

    let expiredState = createGoalLoopState({
      goal: "Stop at iteration deadline",
      cwd,
      goalRunId: "iteration-expired",
      now: () => baseTime,
    });
    expiredState = startGoalIteration(expiredState, { now: baseTime });
    expiredState.iterations[0] = { ...expiredState.iterations[0]!, deadlineAt: baseTime.toISOString() };
    const expired = await runGoalLoop({
      initialState: expiredState,
      cwd,
      goalRunId: "iteration-expired",
      now: () => new Date(baseTime.getTime() + 1),
      todoGenerationRunner: async () => {
        throw new Error("expired generation must not run");
      },
    });
    assert.equal(expired.state.status, "partial");
    assert.match(expired.state.completion?.reason ?? "", /iteration deadline/);
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
