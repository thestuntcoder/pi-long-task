import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CoordinatorResult, RunCoordinatorOptions } from "../src/coordinator.ts";
import { runGoalLoop, type GoalLoopProgressUpdate } from "../src/goal_orchestrator.ts";
import { runGoalReviewSession, type GoalReviewerRunner } from "../src/goal_review.ts";
import { createGoalLoopState, recordGeneratedTodo, recordWorkerResult, startGoalIteration } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";
import { buildTaskProgressModel } from "../src/task_progress.ts";
import type { WorkerSessionFactory, WorkerSessionLike } from "../src/worker_session.ts";

const recoveryConfig = { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 1_000 } as const;
const concreteGoal =
  "Update src/network.ts to recover goal planner and reviewer calls, add focused tests, and run npm test.";

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-goal-network-recovery-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("goal TODO planner recovery resumes the same iteration and excludes outage time", async () => {
  await withTempDir(async (cwd) => {
    let clockMs = Date.parse("2026-09-05T00:00:00.000Z");
    const startedAtMs = clockMs;
    let plannerCalls = 0;
    let executionCalls = 0;
    let reviewerCalls = 0;

    const result = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-planner-recovery",
      minIterations: 1,
      maxIterations: 2,
      timeoutMs: 20_000,
      iterationTimeoutMs: 10_000,
      reviewerTimeoutMs: 5_000,
      networkRecovery: recoveryConfig,
      todoGenerationRunner: async (options) => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          clockMs += 100;
          throw Object.assign(new Error("goal planner connection reset"), { code: "ECONNRESET" });
        }
        clockMs += 250;
        await writeFile(extractGenerationOutputPath(options.inputText ?? ""), sampleTodoMarkdown(), "utf8");
        return coordinatorResult(options, "Recovered planner result", 0.2);
      },
      todoExecutionRunner: async (options) => {
        executionCalls += 1;
        return coordinatorResult(options, "Implementation complete", 0.4);
      },
      reviewerRunner: async () => {
        reviewerCalls += 1;
        return successfulReview(0.3);
      },
      now: () => new Date(clockMs),
    });

    assert.equal(result.state.status, "done");
    assert.equal(plannerCalls, 2);
    assert.equal(executionCalls, 1);
    assert.equal(reviewerCalls, 1);
    assert.equal(result.state.iterations.length, 1, "network retries must not advance the goal loop");
    assert.equal(result.generationResults.length, 1, "network retries must not create planner attempts in loop state");
    assert.equal(Date.parse(result.state.deadlineAt!), startedAtMs + 20_000 + 250);
    assert.equal(Date.parse(result.state.iterations[0]!.deadlineAt!), startedAtMs + 10_000 + 250);
    const waitTrace = result.state.trace.filter((event) => event.event === "network_wait_excluded");
    assert.equal(waitTrace.length, 1);
    assert.deepEqual(waitTrace[0]?.details, { operation: "planner", outageMs: 250 });
  });
});

test("reviewer recovery preserves partial evidence and costs without consuming iterations or timeout", async () => {
  await withTempDir(async (cwd) => {
    let clockMs = Date.parse("2026-09-05T01:00:00.000Z");
    const startedAtMs = clockMs;
    const reviewerTimeouts: number[] = [];
    const progress: GoalLoopProgressUpdate[] = [];
    let reviewerCalls = 0;

    const reviewer: GoalReviewerRunner = async (options) => {
      reviewerCalls += 1;
      reviewerTimeouts.push(options.timeoutMs);
      if (reviewerCalls === 1) {
        clockMs += 100;
        const failure = Object.assign(new Error("review stream disconnected"), { code: "ECONNRESET" });
        return {
          assistantText: "partial reviewer evidence before disconnect",
          reviewerSessionId: "unsafe-reviewer",
          reviewerCostTotal: 0.2,
          error: failure.message,
          failure,
        };
      }
      clockMs += 300;
      return successfulReview(0.3, "replacement-reviewer");
    };

    const result = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-reviewer-recovery",
      minIterations: 1,
      maxIterations: 2,
      timeoutMs: 20_000,
      iterationTimeoutMs: 10_000,
      reviewerTimeoutMs: 5_000,
      networkRecovery: recoveryConfig,
      todoGenerationRunner: successfulGeneration,
      todoExecutionRunner: async (options) => coordinatorResult(options, "Implementation complete", 0.4),
      reviewerRunner: reviewer,
      now: () => new Date(clockMs),
      onProgress: (update) => progress.push(update),
    });

    assert.equal(result.state.status, "done");
    assert.equal(reviewerCalls, 2);
    assert.deepEqual(reviewerTimeouts, [5_000, 5_000], "outage retry retains the reviewer timeout budget");
    assert.equal(result.state.iterations.length, 1);
    assert.equal(result.reviewResults.length, 1);
    assert.equal(result.reviewResults[0]?.reviewerResult.reviewerSessionId, "replacement-reviewer");
    assert.equal(result.reviewResults[0]?.reviewerResult.reviewerCostTotal, 0.5);
    assert.equal(result.state.iterations[0]?.reviewerResult?.reviewerCostTotal, 0.5);
    assert.equal(result.state.iterations[0]?.reviewerRecovery?.reviewerCostTotal, 0.2);
    assert.equal(result.state.iterations[0]?.reviewerRecovery?.interruptions, 1);
    assert.equal(result.state.iterations[0]?.reviewerRecovery?.evidencePaths.length, 1);
    assert.equal(Date.parse(result.state.deadlineAt!), startedAtMs + 20_000 + 300);
    assert.equal(Date.parse(result.state.iterations[0]!.deadlineAt!), startedAtMs + 10_000 + 300);
    const waiting = progress.filter((update) => update.phase === "network_wait");
    assert.deepEqual(
      waiting.map((update) => update.networkRecoveryEvent),
      ["outage_started", "retry_scheduled", "retry_started"],
    );
    assert.match(waiting[1]?.message ?? "", /^Waiting for connection… retry 1 in /);
    const lastWait = progress.map((update) => update.phase).lastIndexOf("network_wait");
    assert.equal(progress[lastWait + 1]?.phase, "review_start", "review status must be restored after reconnecting");
    assert.equal(progress.at(-1)?.phase, "complete");

    const evidencePath = path.join(
      result.state.goalRunDir,
      "iterations",
      "01",
      "REVIEW_RESULT_NETWORK_INTERRUPTED_01.txt",
    );
    assert.equal(await readFile(evidencePath, "utf8"), "partial reviewer evidence before disconnect");
  });
});

test("default reviewer recovery disposes the errored session before using a replacement", async () => {
  await withTempDir(async (cwd) => {
    const now = new Date("2026-09-05T01:30:00.000Z");
    let state = createGoalLoopState({
      goal: concreteGoal,
      cwd,
      goalRunId: "reviewer-session-rotation",
      now: () => now,
    });
    state = startGoalIteration(state, { now });
    state = recordGeneratedTodo(state, 1, { todoPath: path.join(cwd, "TODO.md") }, { now });
    state = recordWorkerResult(
      state,
      1,
      { status: "done", summary: "Worker done", endedAt: now.toISOString() },
      { now },
    );
    const store = new GoalStateStore({ cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });
    await store.saveState(state);

    const sessions: ReviewerSession[] = [];
    const sessionFactory: WorkerSessionFactory = async () => {
      const session =
        sessions.length === 0
          ? new ReviewerSession(
              "errored-reviewer",
              Object.assign(new Error("reviewer socket disconnected"), { code: "ECONNRESET" }),
            )
          : new ReviewerSession("replacement-reviewer", successfulReview().assistantText);
      sessions.push(session);
      return { session };
    };

    const result = await runGoalReviewSession({
      state,
      cwd,
      store,
      sessionFactory,
      networkRecovery: {
        enabled: true,
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxOutageMs: 1_000,
        timeoutPolicy: "exclude-network-wait",
      },
      now: () => new Date(),
    });

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.disposeCalls, 1);
    assert.equal(sessions[1]?.disposeCalls, 1);
    assert.equal(result.reviewerResult.reviewerSessionId, "replacement-reviewer");
  });
});

test("deterministic goal planner and reviewer failures remain fail-fast", async () => {
  await withTempDir(async (cwd) => {
    let plannerCalls = 0;
    const plannerFailure = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-planner-fail-fast",
      networkRecovery: recoveryConfig,
      todoGenerationRunner: async () => {
        plannerCalls += 1;
        throw Object.assign(new Error("invalid goal planner request"), { status: 400 });
      },
      todoExecutionRunner: async () => {
        throw new Error("execution must not run");
      },
      reviewerRunner: async () => {
        throw new Error("review must not run");
      },
    });
    assert.equal(plannerFailure.state.status, "failed");
    assert.equal(plannerCalls, 1);
    assert.equal(plannerFailure.state.iterations.length, 1);

    let reviewerCalls = 0;
    const reviewFailure = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-reviewer-fail-fast",
      networkRecovery: recoveryConfig,
      todoGenerationRunner: successfulGeneration,
      todoExecutionRunner: async (options) => coordinatorResult(options, "Implementation complete"),
      reviewerRunner: async () => {
        reviewerCalls += 1;
        throw Object.assign(new Error("reviewer quota exhausted"), {
          status: 429,
          code: "QUOTA_EXCEEDED",
        });
      },
    });
    assert.equal(reviewFailure.state.status, "failed");
    assert.equal(reviewerCalls, 1);
    assert.equal(reviewFailure.state.iterations.length, 1);
    assert.equal(reviewFailure.state.iterations[0]?.reviewerResult?.decision, "failed");
  });
});

test("reviewer outage expiry follows the failed-review path without advancing the loop", async () => {
  await withTempDir(async (cwd) => {
    let reviewerCalls = 0;
    const result = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-reviewer-recovery-expiry",
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 1 },
      todoGenerationRunner: successfulGeneration,
      todoExecutionRunner: async (options) => coordinatorResult(options, "Implementation complete"),
      reviewerRunner: async () => {
        reviewerCalls += 1;
        const failure = Object.assign(new Error("review network unavailable"), { code: "ENETDOWN" });
        return {
          assistantText: "review evidence captured before outage expiry",
          reviewerCostTotal: 0.1,
          error: failure.message,
          failure,
        };
      },
    });

    assert.equal(reviewerCalls, 1);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.iterations.length, 1);
    assert.equal(result.state.iterations[0]?.reviewerResult?.decision, "failed");
    assert.equal(result.state.iterations[0]?.reviewerResult?.reviewerCostTotal, 0.1);
    assert.match(result.state.completion?.reason ?? "", /configured maximum of 1ms/);
  });
});

test("cancelling reviewer recovery terminates the goal loop as cancelled", async () => {
  await withTempDir(async (cwd) => {
    const controller = new AbortController();
    let reviewerCalls = 0;
    const result = await runGoalLoop({
      goal: concreteGoal,
      cwd,
      goalRunId: "goal-reviewer-recovery-cancel",
      networkRecovery: { enabled: true, baseDelayMs: 50, maxDelayMs: 50, maxOutageMs: null },
      abortSignal: controller.signal,
      todoGenerationRunner: successfulGeneration,
      todoExecutionRunner: async (options) => coordinatorResult(options, "Implementation complete"),
      reviewerRunner: async () => {
        reviewerCalls += 1;
        controller.abort("cancel reviewer outage");
        const failure = Object.assign(new Error("review transport offline"), { code: "ENETDOWN" });
        return {
          assistantText: "partial review before cancellation",
          reviewerCostTotal: 0.2,
          error: failure.message,
          failure,
        };
      },
    });

    assert.equal(reviewerCalls, 1);
    assert.equal(result.state.status, "cancelled");
    assert.equal(result.state.iterations.length, 1);
    assert.equal(result.state.iterations[0]?.status, "cancelled");
    assert.equal(result.state.iterations[0]?.reviewerRecovery?.reviewerCostTotal, 0.2);
    assert.equal(result.state.iterations[0]?.reviewerRecovery?.interruptions, 1);
    assert.match(result.state.completion?.reason ?? "", /cancel reviewer outage/);
  });
});

class ReviewerSession implements WorkerSessionLike {
  readonly messages: unknown[] = [];
  readonly sessionId: string;
  disposeCalls = 0;
  private readonly response: string | Error;

  constructor(sessionId: string, response: string | Error) {
    this.sessionId = sessionId;
    this.response = response;
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(): Promise<void> {
    if (this.response instanceof Error) throw this.response;
    this.messages.push({ role: "assistant", content: this.response });
  }

  getLastAssistantText(): string {
    const message = this.messages.at(-1) as { content?: string } | undefined;
    return message?.content ?? "";
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

async function successfulGeneration(options: RunCoordinatorOptions): Promise<CoordinatorResult> {
  await writeFile(extractGenerationOutputPath(options.inputText ?? ""), sampleTodoMarkdown(), "utf8");
  return coordinatorResult(options, "Generated TODO", 0.1);
}

function successfulReview(cost = 0, sessionId = "reviewer-ok") {
  return {
    assistantText: JSON.stringify({
      decision: "complete",
      complete: true,
      summary: "Goal complete",
      rationale: "The implementation and verification evidence satisfy the goal.",
      remainingWork: [],
    }),
    reviewerSessionId: sessionId,
    reviewerCostTotal: cost,
  };
}

function sampleTodoMarkdown(): string {
  return `# Pi Long Task TODO

## Progress

- [ ] TODO 1 — Implement recovery

---

## TODO 1 — Implement recovery

**Goal:** Implement recovery.

**Status:**
- [ ] Implement recovery.

**Verify:**
- Run focused tests.

**Done when:**
- Recovery is verified.
`;
}

function coordinatorResult(options: RunCoordinatorOptions, summary: string, workerCostTotal = 0): CoordinatorResult {
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
    workerCostTotal,
    commit: options.commit,
    goal: options.goal,
  };
}

function extractGenerationOutputPath(payloadText: string): string {
  const match = /Write the generated Pi Long Task-compatible TODO markdown to `([^`]+)`/.exec(payloadText);
  assert.ok(match?.[1], "expected output path in generation payload");
  return match[1];
}
