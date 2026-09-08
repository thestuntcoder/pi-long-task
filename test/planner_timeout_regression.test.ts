import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runCoordinator,
  runTodoPlanner,
  type CoordinatorProgressUpdate,
  type PlannerDiagnostic,
} from "../src/coordinator.ts";
import { MAX_ADAPTIVE_PLANNER_TIMEOUT_MS } from "../src/planner_config.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome, WorkerSessionLike } from "../src/worker_session.ts";

const LEGACY_FIXED_PLANNER_TIMEOUT_MS = 300_000;

class DelayedPlannerSession implements WorkerSessionLike {
  readonly messages: unknown[] = [];
  readonly followUps: string[] = [];
  readonly promptStarted: Promise<void>;
  private startPrompt: (() => void) | undefined;
  private readonly markdown: string;
  private readonly delayMs: number;

  constructor(markdown: string, delayMs: number) {
    this.markdown = markdown;
    this.delayMs = delayMs;
    this.promptStarted = new Promise<void>((resolve) => {
      this.startPrompt = resolve;
    });
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(): Promise<void> {
    this.startPrompt?.();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.messages.push({ role: "assistant", content: this.markdown });
        resolve();
      }, this.delayMs);
    });
  }

  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
  }

  getLastAssistantText(): string {
    const message = this.messages.at(-1) as { content?: string } | undefined;
    return message?.content ?? "";
  }
}

class PartialPendingPlannerSession implements WorkerSessionLike {
  readonly sessionId = "partial-after-recovery";
  readonly promptStarted: Promise<void>;
  abortCalls = 0;
  private startPrompt: (() => void) | undefined;
  private settlePrompt: (() => void) | undefined;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor() {
    this.promptStarted = new Promise<void>((resolve) => {
      this.startPrompt = resolve;
    });
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(): Promise<void> {
    for (const listener of this.listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "# Pi Long Task TODO\n\ntruncated" },
      });
    }
    this.startPrompt?.();
    await new Promise<void>((resolve) => {
      this.settlePrompt = resolve;
    });
  }

  async followUp(): Promise<void> {}

  abort(): void {
    this.abortCalls += 1;
    this.settlePrompt?.();
  }
}

function doneOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-08T12:00:00.000Z",
    endedAt: "2026-09-08T12:00:01.000Z",
    reportedStatus: "done",
    done: true,
    assistantText:
      "TASK_RESULT:\nstatus: done\nsummary: complete\nchanges:\n- none\nverification:\n- deterministic regression test\nremaining:\n- none",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

async function withTempDir<T>(prefix: string, run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("24-item planning can finish beyond the former fixed five-minute deadline", async (t) => {
  await withTempDir("pi-planner-old-timeout-regression-", async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const taskTitles = Array.from({ length: 24 }, (_, index) => `Implement story ${index + 1}`);
    const session = new DelayedPlannerSession(generatedTodoMarkdown(taskTitles), LEGACY_FIXED_PLANNER_TIMEOUT_MS + 1);
    const updates: CoordinatorProgressUpdate[] = [];

    const runPromise = runCoordinator({
      inputText: "Create 24 separately planned user stories, with one independently assignable task per story.",
      cwd,
      runId: "old-five-minute-timeout-regression",
      commit: false,
      todoSessionFactory: async () => ({ session }),
      workerRunner: async (options) => doneOutcome(options),
      onProgress: (update) => updates.push(update),
    });

    await session.promptStarted;
    const started = updates.find((update) => update.phase === "planning" && update.plannerProgressState === "started");
    assert.equal(started?.plannerBudget?.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
    assert.equal(started?.plannerBudget?.source, "adaptive");
    assert.match(started?.message ?? "", /Effective planning budget: 15 minutes/);
    assert.match(started?.message ?? "", /24 separately planned tasks/);

    t.mock.timers.tick(LEGACY_FIXED_PLANNER_TIMEOUT_MS);
    assert.equal(session.messages.length, 0, "the planner is still working at the former deadline");
    assert.equal(
      updates.some((update) => update.plannerProgressState === "grace"),
      false,
      "the adaptive deadline must not enter grace at five minutes",
    );

    t.mock.timers.tick(1);
    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(result.totalTasks, 24);
    assert.equal(result.completedTasks, 24);
    assert.equal(result.plannerBudget?.timeoutMs, MAX_ADAPTIVE_PLANNER_TIMEOUT_MS);
  });
});

test("explicit timeout and grace overrides remain authoritative for a complex request", async (t) => {
  await withTempDir("pi-planner-explicit-grace-regression-", async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = new DelayedPlannerSession(
      generatedTodoMarkdown(["Finish safely during explicit grace"]),
      LEGACY_FIXED_PLANNER_TIMEOUT_MS + 10_000,
    );
    const updates: CoordinatorProgressUpdate[] = [];

    const runPromise = runCoordinator({
      inputText:
        "Planner timeout: 15m\nPlanner grace period: 1m\nCreate 24 separately planned stories, but use the structured options.",
      cwd,
      runId: "explicit-timeout-and-grace",
      commit: false,
      todoTimeoutMs: LEGACY_FIXED_PLANNER_TIMEOUT_MS,
      todoGracefulShutdownMs: 20_000,
      todoSessionFactory: async () => ({ session }),
      workerRunner: async (options) => doneOutcome(options),
      onProgress: (update) => updates.push(update),
    });

    await session.promptStarted;
    const started = updates.find((update) => update.plannerProgressState === "started");
    assert.equal(started?.plannerBudget?.source, "explicit");
    assert.equal(started?.plannerBudget?.timeoutMs, LEGACY_FIXED_PLANNER_TIMEOUT_MS);
    assert.equal(started?.plannerGracePeriodMs, 20_000);
    assert.doesNotMatch(started?.message ?? "", /Adaptive extension/);

    t.mock.timers.tick(LEGACY_FIXED_PLANNER_TIMEOUT_MS);
    const grace = updates.find((update) => update.plannerProgressState === "grace");
    assert.equal(grace?.plannerGraceRemainingMs, 20_000);
    assert.match(grace?.message ?? "", /entering a 20-second graceful-shutdown period/);
    assert.equal(session.followUps.length, 1);

    t.mock.timers.tick(10_000);
    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(result.plannerBudget?.source, "explicit");
    assert.equal(result.plannerBudget?.timeoutMs, LEGACY_FIXED_PLANNER_TIMEOUT_MS);
  });
});

test("network recovery does not reset a planner deadline or hide partial-output timeout diagnostics", async (t) => {
  await withTempDir("pi-planner-network-timeout-regression-", async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = new PartialPendingPlannerSession();
    const diagnostics: PlannerDiagnostic[] = [];
    const updates: CoordinatorProgressUpdate[] = [];
    let plannerCalls = 0;
    let releaseRecoveryScheduled: (() => void) | undefined;
    const recoveryScheduled = new Promise<void>((resolve) => {
      releaseRecoveryScheduled = resolve;
    });

    const runPromise = runCoordinator({
      inputText: "Create a plan after a recoverable provider interruption.",
      cwd,
      runId: "network-recovery-then-timeout",
      commit: false,
      todoTimeoutMs: 100,
      todoGracefulShutdownMs: 50,
      todoPlanner: async (options) => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          throw Object.assign(new Error("temporary connection reset"), { code: "ECONNRESET" });
        }
        return runTodoPlanner({
          ...options,
          sessionFactory: async () => ({ session }),
          onDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
            options.onDiagnostic?.(diagnostic);
          },
        });
      },
      workerRunner: async (options) => doneOutcome(options),
      networkRecovery: { enabled: true, baseDelayMs: 10, maxDelayMs: 10, maxOutageMs: 1_000 },
      onProgress: (update) => {
        updates.push(update);
        if (update.networkRecoveryEvent === "retry_scheduled") {
          releaseRecoveryScheduled?.();
        }
      },
    });

    await recoveryScheduled;
    const networkWait = updates.find((update) => update.networkRecoveryEvent === "retry_scheduled");
    assert.equal(networkWait?.networkOperation, "planner");
    assert.equal(networkWait?.plannerDeadlinePolicy, "per_attempt_excludes_network_wait");
    assert.match(networkWait?.message ?? "", /planning deadline remains unchanged/i);

    t.mock.timers.tick(10);
    await session.promptStarted;
    t.mock.timers.tick(100);
    t.mock.timers.tick(50);

    const result = await runPromise;
    assert.equal(result.status, "failed");
    assert.equal(plannerCalls, 2);
    assert.equal(session.abortCalls, 1);
    assert.equal(diagnostics.at(-1)?.kind, "timeout");
    assert.equal(diagnostics.at(-1)?.partialOutputObserved, true);

    const taskResult = await readFile(result.taskResultPath, "utf8");
    assert.match(taskResult, /- network_recovery: TODO planner network recovery started/);
    assert.match(taskResult, /- timeout: TODO planner timed out/);
    assert.match(taskResult, /Partial output observed: yes/);
    assert.doesNotMatch(taskResult, /truncated/);
  });
});
