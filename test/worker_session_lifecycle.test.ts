import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CoordinatorWorkerSessionOwner,
  runCoordinator,
  workerSessionHealthForOutcome,
  type CoordinatorProgressUpdate,
  type WorkerAssignmentIdentity,
} from "../src/coordinator.ts";
import { SerializedSteeringQueue } from "../src/steering.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, WorkerSessionFactory, WorkerSessionLike } from "../src/worker_session.ts";

type FakeResponse = string | Error | { response: string; delayMs: number };

class SequentialFakeSession implements WorkerSessionLike {
  readonly prompts: string[] = [];
  readonly messages: unknown[] = [];
  disposeCalls = 0;
  private listeners: Array<(event: unknown) => void> = [];
  private readonly responseForPrompt: (prompt: string, promptNumber: number) => FakeResponse;
  private readonly contextUsage: number | Error;
  private contextUsageCalls = 0;

  constructor(
    responseForPrompt: (prompt: string, promptNumber: number) => FakeResponse = (prompt) => {
      const taskId = /Assigned task: `TODO (\d+) —/.exec(prompt)?.[1] ?? "unknown";
      return completeResult("done", `result-for-${taskId}`);
    },
    contextUsage: number | Error = 10,
  ) {
    this.responseForPrompt = responseForPrompt;
    this.contextUsage = contextUsage;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    const scripted = this.responseForPrompt(prompt, this.prompts.length);
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted !== "string") {
      await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    }
    const response = typeof scripted === "string" ? scripted : scripted.response;
    const message = { id: `response-${this.prompts.length}`, role: "assistant", content: response };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end", message, toolResults: [] });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  getContextUsage(): unknown {
    this.contextUsageCalls += 1;
    if (this.contextUsage instanceof Error) {
      if (this.contextUsageCalls > 1) throw this.contextUsage;
      return { percent: 10 };
    }
    return { percent: this.contextUsage };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

function completeResult(status: "done" | "partial" | "failed" | "blocked", summary: string): string {
  return `TASK_RESULT:\nstatus: ${status}\nsummary: ${summary}\nchanges:\n- fake change\nverification:\n- fake\nremaining:\n- ${status === "done" ? "none" : "retry task"}`;
}

class AccountingFakeSession implements WorkerSessionLike {
  readonly prompts: string[] = [];
  readonly messages: unknown[] = [];
  disposeCalls = 0;
  private listeners: Array<(event: unknown) => void> = [];
  private readonly responses: string[];
  private readonly cumulativeCosts: Array<number | undefined>;
  private readonly messageCosts: Array<number | undefined>;

  constructor(
    responses: string[],
    cumulativeCosts: Array<number | undefined>,
    messageCosts: Array<number | undefined> = [],
  ) {
    this.responses = responses;
    this.cumulativeCosts = cumulativeCosts;
    this.messageCosts = messageCosts;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(prompt: string): Promise<void> {
    const index = this.prompts.length;
    this.prompts.push(prompt);
    const response = this.responses[index] ?? completeResult("done", `accounted-${index + 1}`);
    const cost = this.messageCosts[index];
    const message = {
      id: `accounting-${index + 1}`,
      role: "assistant",
      content: response,
      ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }),
    };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end", message, toolResults: [] });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  getSessionStats(): unknown {
    if (this.prompts.length === 0) {
      return this.cumulativeCosts[0] === undefined ? undefined : stats(0);
    }
    const cumulative = this.cumulativeCosts[this.prompts.length - 1];
    return cumulative === undefined ? undefined : stats(cumulative);
  }

  getContextUsage(): unknown {
    return { percent: 20 };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

function stats(cost: number): unknown {
  const tokens = cost * 20;
  return {
    cost,
    tokens: { input: tokens / 2, output: tokens / 2, cacheRead: 0, cacheWrite: 0, total: tokens },
  };
}

function countingFactory(
  created: SequentialFakeSession[],
  create: (index: number) => SequentialFakeSession = () => new SequentialFakeSession(),
): WorkerSessionFactory {
  return async () => {
    const session = create(created.length);
    created.push(session);
    return { session };
  };
}

test("coordinator retains one healthy session across sequential TODO assignments", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-retained-worker-"));
  try {
    const created: SequentialFakeSession[] = [];
    const progress: CoordinatorProgressUpdate[] = [];
    const result = await runCoordinator({
      cwd,
      runId: "retained",
      inputText: generatedTodoMarkdown(["First retained task", "Second retained task", "Third retained task"]),
      commit: false,
      taskTimeoutMs: 0,
      workerSessionFactory: countingFactory(created),
      onProgress: (update) => progress.push(update),
    });

    assert.equal(result.status, "done");
    assert.equal(result.totalTasks, 3);
    assert.equal(result.completedTasks, 3);
    assert.equal(result.attemptedTasks, 3);
    assert.equal(result.failedTasks, 0);
    assert.equal(result.blockedTasks, 0);
    assert.equal(created.length, 1);
    assert.equal(created[0].disposeCalls, 1);
    assert.equal(created[0].prompts.length, 3);
    assert.doesNotMatch(created[0].prompts[0], /Pi Long Task assignment boundary:/);
    assert.match(created[0].prompts[1], /Pi Long Task assignment boundary:/);
    assert.match(created[0].prompts[1], /The prior assignment TODO 1 — First retained task has ended\./);
    assert.match(created[0].prompts[1], /A new, independent assignment has begun: TODO 2 — Second retained task\./);
    assert.match(created[0].prompts[1], /Assigned task: `TODO 2 — Second retained task`/);
    assert.match(created[0].prompts[2], /The prior assignment TODO 2 — Second retained task has ended\./);
    assert.match(created[0].prompts[2], /A new, independent assignment has begun: TODO 3 — Third retained task\./);
    assert.match(created[0].prompts[2], /Assigned task: `TODO 3 — Third retained task`/);
    assert.equal(
      created[0].prompts.slice(1).every((prompt) => prompt.includes("TASK_RESULT:")),
      true,
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.task.taskId, outcome.reportedStatus, outcome.done]),
      [
        ["1", "done", true],
        ["2", "done", true],
        ["3", "done", true],
      ],
    );
    for (const [index, outcome] of result.outcomes.entries()) {
      const taskId = String(index + 1);
      assert.match(outcome.assistantText, new RegExp(`summary: result-for-${taskId}`));
      for (const otherTaskId of ["1", "2", "3"].filter((candidate) => candidate !== taskId)) {
        assert.doesNotMatch(outcome.assistantText, new RegExp(`result-for-${otherTaskId}`));
      }
    }
    assert.deepEqual(result.workerSessionMetrics, {
      starts: 1,
      reuses: 2,
      rotations: 0,
      retained: 3,
      rotationReasons: {},
    });
    assert.deepEqual(
      progress
        .filter((update) => update.phase === "task_start" || update.phase === "task_done")
        .map((update) => [
          update.phase,
          update.taskId,
          update.taskProgress?.tasks.find((task) => task.taskId === update.taskId)?.status,
        ]),
      [
        ["task_start", "1", "current"],
        ["task_done", "1", "completed"],
        ["task_start", "2", "current"],
        ["task_done", "2", "completed"],
        ["task_start", "3", "current"],
        ["task_done", "3", "completed"],
      ],
    );
    const persistedResults = await readFile(result.taskResultPath, "utf8");
    assert.equal((persistedResults.match(/^## TODO \d+ — .* \(attempt 1\)$/gm) ?? []).length, 3);
    assert.equal((persistedResults.match(/^status: done$/gm) ?? []).length, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("threshold and failed health checks rotate before the next sequential assignment", async (t) => {
  for (const scenario of [
    { name: "threshold", context: 62.5, reason: "context_threshold_reached" },
    {
      name: "health-check-failure",
      context: new Error("health check failed"),
      reason: "context_usage_unavailable",
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `pi-rotate-${scenario.name}-`));
      try {
        const created: SequentialFakeSession[] = [];
        const result = await runCoordinator({
          cwd,
          runId: `rotate-${scenario.name}`,
          inputText: generatedTodoMarkdown(["First task", "Second task"]),
          commit: false,
          taskTimeoutMs: 0,
          workerSessionReuseContextThresholdPercent: 62.5,
          workerSessionFactory: countingFactory(
            created,
            (index) => new SequentialFakeSession(undefined, index === 0 ? scenario.context : 10),
          ),
        });

        assert.equal(result.status, "done");
        assert.equal(created.length, 2);
        assert.deepEqual(
          created.map((session) => session.disposeCalls),
          [1, 1],
        );
        assert.deepEqual(
          created.map((session) => session.prompts.length),
          [1, 1],
        );
        assert.deepEqual(result.workerSessionMetrics, {
          starts: 2,
          reuses: 0,
          rotations: 1,
          retained: 1,
          rotationReasons: { [scenario.reason]: 1 },
        });
        assert.ok(
          result.outcomes[0].sessionDiagnostics?.some(
            (item) => item.event === "session_rotated" && item.reasonCode === scenario.reason,
          ),
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("an explicit partial result may continue only in the same healthy session and next attempt", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-partial-continuation-"));
  try {
    const created: SequentialFakeSession[] = [];
    const result = await runCoordinator({
      cwd,
      runId: "partial-continuation",
      inputText: generatedTodoMarkdown(["Continue partial work"]),
      commit: false,
      taskTimeoutMs: 0,
      maxAttemptsPerTask: 2,
      workerSessionFactory: countingFactory(
        created,
        () =>
          new SequentialFakeSession((_prompt, promptNumber) =>
            completeResult(promptNumber === 1 ? "partial" : "done", `attempt-${promptNumber}`),
          ),
      ),
    });

    assert.equal(result.status, "done");
    assert.equal(created.length, 1);
    assert.equal(created[0].disposeCalls, 1);
    assert.equal(created[0].prompts.length, 2);
    assert.match(created[0].prompts[1], /Attempt: 2/);
    assert.deepEqual(
      result.attempts.map((attempt) => [attempt.attempt, attempt.reportedStatus]),
      [
        [1, "partial"],
        [2, "done"],
      ],
    );
    assert.deepEqual(result.workerSessionMetrics, {
      starts: 1,
      reuses: 1,
      rotations: 0,
      retained: 2,
      rotationReasons: {},
    });
    assert.match(result.outcomes[0].assistantText, /summary: attempt-1/);
    assert.doesNotMatch(result.outcomes[0].assistantText, /attempt-2/);
    assert.match(result.outcomes[1].assistantText, /summary: attempt-2/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("independent failure, timeout, unrecoverable error, and invalid-state retries start fresh", async (t) => {
  const scenarios: Array<{
    name: string;
    taskTimeoutMs: number;
    firstResponse: (prompt: string, promptNumber: number) => FakeResponse;
    rotationReason: string;
    assertFirst?: (result: Awaited<ReturnType<typeof runCoordinator>>) => void;
  }> = [
    {
      name: "independent-failure",
      taskTimeoutMs: 0,
      firstResponse: () => completeResult("failed", "independent failure"),
      rotationReason: "retry_after_non_partial_status",
    },
    {
      name: "timeout",
      taskTimeoutMs: 1,
      firstResponse: () => ({ response: completeResult("partial", "timed out partial"), delayMs: 15 }),
      rotationReason: "health_timed_out",
      assertFirst: (result) => assert.equal(result.outcomes[0].timedOut, true),
    },
    {
      name: "unrecoverable-error",
      taskTimeoutMs: 0,
      firstResponse: () => new Error("transport failed"),
      rotationReason: "health_unrecoverable_error",
      assertFirst: (result) => assert.match(result.outcomes[0].error ?? "", /transport failed/),
    },
    {
      name: "invalid-state",
      taskTimeoutMs: 0,
      firstResponse: () => "TASK_RESULT:\nstatus: done",
      rotationReason: "health_invalid_state",
      assertFirst: (result) => assert.equal(result.outcomes[0].done, false),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `pi-retry-${scenario.name}-`));
      try {
        const created: SequentialFakeSession[] = [];
        const result = await runCoordinator({
          cwd,
          runId: `retry-${scenario.name}`,
          inputText: generatedTodoMarkdown(["Retry safely"]),
          commit: false,
          taskTimeoutMs: scenario.taskTimeoutMs,
          maxAttemptsPerTask: 2,
          workerSessionFactory: countingFactory(
            created,
            (index) => new SequentialFakeSession(index === 0 ? scenario.firstResponse : undefined),
          ),
        });

        assert.equal(result.status, "done");
        assert.equal(result.attemptedTasks, 2);
        assert.equal(created.length, 2);
        assert.deepEqual(
          created.map((session) => session.disposeCalls),
          [1, 1],
        );
        assert.equal(created[0].prompts.length, scenario.name === "invalid-state" ? 2 : 1);
        assert.equal(created[1].prompts.length, 1);
        assert.equal(result.attempts[0].attempt, 1);
        assert.equal(result.attempts[1].attempt, 2);
        assert.equal(result.attempts[1].reportedStatus, "done");
        assert.deepEqual(result.workerSessionMetrics, {
          starts: 2,
          reuses: 0,
          rotations: 1,
          retained: 1,
          rotationReasons: { [scenario.rotationReason]: 1 },
        });
        assert.match(result.outcomes[1].assistantText, /summary: result-for-1/);
        assert.doesNotMatch(result.outcomes[1].assistantText, /independent failure|timed out partial/);
        scenario.assertFirst?.(result);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("an aborted timeout retry cannot continue in the affected session", async () => {
  class NonSettlingSession implements WorkerSessionLike {
    disposeCalls = 0;
    abortCalls = 0;
    subscribe(): () => void {
      return () => {};
    }
    async prompt(): Promise<void> {
      await new Promise<void>(() => {});
    }
    abort(): void {
      this.abortCalls += 1;
    }
    dispose(): void {
      this.disposeCalls += 1;
    }
    getContextUsage(): unknown {
      return { percent: 10 };
    }
  }

  const stuck = new NonSettlingSession();
  const replacement = new SequentialFakeSession();
  let factoryCalls = 0;
  const factory: WorkerSessionFactory = async () => ({
    session: factoryCalls++ === 0 ? stuck : replacement,
  });
  const owner = new CoordinatorWorkerSessionOwner({
    runId: "aborted-timeout",
    cwd: "/tmp/aborted-timeout",
    workerSessionReuse: true,
    workerSessionReuseContextThresholdPercent: 62.5,
  });
  const options = (attempt: number): RunWorkerTaskOptions => ({
    cwd: "/tmp/aborted-timeout",
    todoPath: "/tmp/aborted-timeout/TODO.md",
    task: { taskId: "1", title: "Abort safely", section: "## TODO 1 — Abort safely" },
    attempt,
    commitRequested: false,
    maxBashTimeoutSeconds: 300,
    taskTimeoutSeconds: attempt === 1 ? 0.001 : 0,
    gracefulShutdownSeconds: 0.001,
    sessionFactory: factory,
  });

  const first = await owner.run(options(1));
  assert.equal(first.timedOut, true);
  assert.equal(first.aborted, true);
  assert.equal(stuck.abortCalls, 1);
  assert.equal(stuck.disposeCalls, 1);

  const second = await owner.run(options(2));
  assert.equal(second.done, true);
  assert.equal(factoryCalls, 2);
  await owner.dispose();
  assert.equal(stuck.disposeCalls, 1);
  assert.equal(replacement.disposeCalls, 1);
});

test("configuration changes and cancellation rotate through exact-once ownership", async () => {
  const created: SequentialFakeSession[] = [];
  const diagnostics: Array<{ event: string; reasonCode: string }> = [];
  const factory = countingFactory(created);
  const owner = new CoordinatorWorkerSessionOwner({
    runId: "owner-matrix",
    cwd: "/tmp/owner-matrix",
    workerSessionReuse: true,
    workerSessionReuseContextThresholdPercent: 62.5,
  });
  const options = (
    taskId: string,
    attempt: number,
    overrides: Partial<RunWorkerTaskOptions> = {},
  ): RunWorkerTaskOptions => ({
    cwd: "/tmp/owner-matrix",
    todoPath: "/tmp/owner-matrix/TODO.md",
    task: { taskId, title: `Task ${taskId}`, section: `## TODO ${taskId} — Task ${taskId}` },
    attempt,
    commitRequested: false,
    maxBashTimeoutSeconds: 300,
    taskTimeoutSeconds: 0,
    thinkingLevel: "high",
    modelName: "anthropic/model-a",
    sessionFactory: factory,
    onSessionDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });

  await owner.run(options("1", 1));
  await owner.run(options("2", 1, { thinkingLevel: "xhigh" }));
  assert.equal(created.length, 2);
  assert.equal(created[0].disposeCalls, 1);

  const aborted = new AbortController();
  aborted.abort("cancelled");
  const cancelledOutcome = await owner.run(options("3", 1, { abortSignal: aborted.signal }));
  assert.equal(cancelledOutcome.aborted, true);
  assert.equal(created.length, 3);
  assert.equal(created[1].disposeCalls, 1);
  assert.equal(created[2].disposeCalls, 1);

  await owner.run(options("3", 2));
  assert.equal(created.length, 4);
  await owner.dispose();
  await owner.dispose();
  assert.deepEqual(
    created.map((session) => session.disposeCalls),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    diagnostics
      .filter((diagnostic) => diagnostic.event === "session_rotated")
      .map((diagnostic) => diagnostic.reasonCode),
    ["worker_options_mismatch", "worker_options_mismatch", "health_cancelled"],
  );
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.event === "session_started").length, created.length);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "session_reused"),
    false,
  );
});

test("reused cumulative statistics are attributed as task deltas with lifecycle evidence", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-accounting-reuse-"));
  try {
    const session = new AccountingFakeSession(
      [completeResult("done", "cost-five"), completeResult("done", "cost-four")],
      [5, 9],
    );
    const progress: Array<{ phase: string; event?: string; reason?: string; context?: number }> = [];
    const result = await runCoordinator({
      cwd,
      runId: "accounting-reuse",
      inputText: generatedTodoMarkdown(["Cost task one", "Cost task two"]),
      commit: false,
      taskTimeoutMs: 0,
      workerSessionFactory: async () => ({ session }),
      onProgress: (update) =>
        progress.push({
          phase: update.phase,
          event: update.workerSessionEvent,
          reason: update.workerSessionReason,
          context: update.workerSessionContextUsagePercent,
        }),
    });

    assert.equal(session.disposeCalls, 1);
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.workerCostTotal),
      [5, 4],
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.workerUsage?.total),
      [100, 80],
    );
    assert.equal(result.workerCostTotal, 9);
    assert.deepEqual(result.workerUsageTotal, {
      input: 90,
      output: 90,
      cacheRead: 0,
      cacheWrite: 0,
      total: 180,
    });
    assert.deepEqual(result.workerSessionMetrics, {
      starts: 1,
      reuses: 1,
      rotations: 0,
      retained: 2,
      rotationReasons: {},
    });
    assert.ok(result.outcomes[0].sessionDiagnostics?.some((item) => item.event === "session_started"));
    assert.ok(
      result.outcomes[1].sessionDiagnostics?.some(
        (item) => item.event === "session_reused" && item.contextUsagePercent === 20,
      ),
    );
    assert.ok(
      progress.some(
        (item) =>
          item.phase === "worker_session" &&
          item.event === "session_reused" &&
          item.reason === "reuse_eligible" &&
          item.context === 20,
      ),
    );
    const resultMarkdown = await readFile(result.taskResultPath, "utf8");
    assert.match(resultMarkdown, /Worker cost: 4 \(session_stats\)/);
    assert.match(resultMarkdown, /event=session_reused reason=reuse_eligible context=20\.0%/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("accounting handles retries, rotation, missing statistics, and counter resets exactly once", async (t) => {
  await t.test("rotated retry sessions retain both attempt costs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-accounting-retry-"));
    try {
      const sessions = [
        new AccountingFakeSession([completeResult("failed", "failed-cost")], [3]),
        new AccountingFakeSession([completeResult("done", "retry-cost")], [2]),
      ];
      let factoryIndex = 0;
      const result = await runCoordinator({
        cwd,
        runId: "accounting-retry",
        inputText: generatedTodoMarkdown(["Retry accounting"]),
        commit: false,
        taskTimeoutMs: 0,
        maxAttemptsPerTask: 2,
        workerSessionFactory: async () => ({ session: sessions[factoryIndex++] }),
      });
      assert.deepEqual(
        sessions.map((session) => session.disposeCalls),
        [1, 1],
      );
      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.workerCostTotal),
        [3, 2],
      );
      assert.equal(result.workerCostTotal, 5);
      assert.equal(result.workerSessionMetrics?.starts, 2);
      assert.equal(result.workerSessionMetrics?.rotations, 1);
      assert.deepEqual(result.workerSessionMetrics?.rotationReasons, { retry_after_non_partial_status: 1 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await t.test("a cumulative counter reset starts a new nonnegative baseline", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-accounting-reset-"));
    try {
      const session = new AccountingFakeSession(
        [completeResult("done", "before-reset"), completeResult("done", "after-reset")],
        [5, 2],
      );
      const result = await runCoordinator({
        cwd,
        runId: "accounting-reset",
        inputText: generatedTodoMarkdown(["Before reset", "After reset"]),
        commit: false,
        taskTimeoutMs: 0,
        workerSessionFactory: async () => ({ session }),
      });
      assert.equal(session.disposeCalls, 1);
      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.workerCostTotal),
        [5, 2],
      );
      assert.equal(result.workerCostTotal, 7);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await t.test("missing cumulative statistics fall back to invocation message costs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-accounting-missing-"));
    try {
      const session = new AccountingFakeSession(
        [completeResult("done", "event-five"), completeResult("done", "event-four")],
        [undefined, undefined],
        [5, 4],
      );
      const result = await runCoordinator({
        cwd,
        runId: "accounting-missing",
        inputText: generatedTodoMarkdown(["Event cost one", "Event cost two"]),
        commit: false,
        taskTimeoutMs: 0,
        workerSessionFactory: async () => ({ session }),
      });
      assert.equal(session.disposeCalls, 1);
      assert.deepEqual(
        result.outcomes.map((outcome) => [outcome.workerCostTotal, outcome.workerCostSource]),
        [
          [5, "message_end"],
          [4, "message_end"],
        ],
      );
      assert.equal(result.workerCostTotal, 9);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("outcome health classification covers timeout, abort, cancellation, error, and invalid state", () => {
  const valid = completeResult("done", "valid");
  const base = { timedOut: false, aborted: false, error: undefined, assistantText: valid };
  assert.equal(workerSessionHealthForOutcome(base), "healthy");
  assert.equal(workerSessionHealthForOutcome({ ...base, timedOut: true }), "timed_out");
  assert.equal(workerSessionHealthForOutcome({ ...base, aborted: true }), "aborted");
  assert.equal(workerSessionHealthForOutcome(base, true), "cancelled");
  assert.equal(workerSessionHealthForOutcome({ ...base, error: "failed" }), "unrecoverable_error");
  assert.equal(workerSessionHealthForOutcome({ ...base, assistantText: "status: done" }), "invalid_state");
});

test("steering aborts an obsolete retained assignment and ignores its late result", async () => {
  class LateObsoleteSession implements WorkerSessionLike {
    readonly messages: unknown[] = [];
    abortCalls = 0;
    disposeCalls = 0;
    private listeners: Array<(event: unknown) => void> = [];
    private resolvePrompt: (() => void) | undefined;
    private readonly onPrompt: () => void;

    constructor(onPrompt: () => void) {
      this.onPrompt = onPrompt;
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((item) => item !== listener);
      };
    }

    async prompt(): Promise<void> {
      this.onPrompt();
      await new Promise<void>((resolve) => {
        this.resolvePrompt = resolve;
      });
    }

    abort(): void {
      this.abortCalls += 1;
    }

    deliverLate(): void {
      const response = completeResult("done", "LATE-OBSOLETE-RESULT");
      const message = { role: "assistant", content: response };
      this.messages.push(message);
      for (const listener of this.listeners) {
        listener({ type: "message_end", message });
        listener({ type: "agent_end", messages: this.messages });
      }
      this.resolvePrompt?.();
    }

    getContextUsage(): unknown {
      return { percent: 10 };
    }

    dispose(): void {
      this.disposeCalls += 1;
    }
  }

  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-steering-retained-obsolete-"));
  try {
    const queue = new SerializedSteeringQueue({ queueId: "retained-obsolete" });
    let queued = false;
    let obsoleteSession: LateObsoleteSession | undefined;
    const replacements: SequentialFakeSession[] = [];
    const updates: CoordinatorProgressUpdate[] = [];
    const factory: WorkerSessionFactory = async () => {
      if (!obsoleteSession) {
        obsoleteSession = new LateObsoleteSession(() => {
          if (!queued) {
            queued = true;
            queue.enqueue("Replace REST implementation with GraphQL.", "interactive");
          }
        });
        return { session: obsoleteSession };
      }
      const session = new SequentialFakeSession();
      replacements.push(session);
      return { session };
    };

    const result = await runCoordinator({
      cwd,
      runId: "retained-obsolete",
      inputText: generatedTodoMarkdown(["Build REST API", "Document API"]),
      commit: false,
      taskTimeoutMs: 0,
      steeringQueue: queue,
      todoPlanner: async () => generatedTodoMarkdown(["Build GraphQL API", "Document API"]),
      workerSessionFactory: factory,
      onProgress: (update) => {
        updates.push(update);
        if (update.phase === "task_start" && update.title === "Build GraphQL API") {
          obsoleteSession?.deliverLate();
        }
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.attempts[0]?.obsolete, true);
    assert.equal(result.outcomes[0]?.aborted, true);
    assert.equal(obsoleteSession?.abortCalls, 1);
    assert.equal(obsoleteSession?.disposeCalls, 1);
    assert.equal(replacements.length, 1, "replacement and following task should share one fresh session");
    assert.equal(replacements[0]?.disposeCalls, 1);
    assert.equal(replacements[0]?.prompts.length, 2);
    assert.deepEqual(result.workerSessionMetrics, {
      starts: 2,
      reuses: 1,
      rotations: 1,
      retained: 2,
      rotationReasons: { steering_revision_obsolete: 1 },
    });
    assert.equal(
      updates.some((update) => update.message.includes("LATE-OBSOLETE-RESULT")),
      false,
      "late obsolete events must not repaint current progress",
    );
    assert.equal(updates.filter((update) => update.phase === "task_obsolete").length, 1);
    assert.equal(
      updates.filter((update) => update.phase === "task_done" && update.title === "Build GraphQL API").length,
      1,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("completion, cancellation, and owner disposal race through one cleanup path", async () => {
  let releasePrompt: (() => void) | undefined;
  let promptStartedResolve: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    promptStartedResolve = resolve;
  });
  const session = new SequentialFakeSession(asyncResponse);

  function asyncResponse(): FakeResponse {
    return completeResult("done", "completion-race");
  }

  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (prompt: string) => {
    promptStartedResolve?.();
    await new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    await originalPrompt(prompt);
  };

  const owner = new CoordinatorWorkerSessionOwner({
    runId: "completion-cancel-race",
    cwd: "/tmp/completion-cancel-race",
    workerSessionReuse: true,
    workerSessionReuseContextThresholdPercent: 62.5,
  });
  const identity: WorkerAssignmentIdentity = {
    assignmentId: "race:1",
    taskIdentity: "race-task",
    steeringGeneration: 4,
    planAuthorityToken: "plan:race",
  };
  const run = owner.run(
    {
      cwd: "/tmp/completion-cancel-race",
      todoPath: "/tmp/completion-cancel-race/TODO.md",
      task: { taskId: "1", title: "Race task", section: "## TODO 1 — Race task" },
      attempt: 1,
      commitRequested: false,
      maxBashTimeoutSeconds: 300,
      taskTimeoutSeconds: 0,
      sessionFactory: async () => ({ session }),
    },
    identity,
  );
  await promptStarted;
  releasePrompt?.();
  const [outcome] = await Promise.all([run, owner.dispose(), owner.dispose()]);

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.done, false);
  assert.equal(session.disposeCalls, 1);
  await assert.rejects(() => owner.run({} as RunWorkerTaskOptions), /owner is closed/);
});

test("coordinator shutdown disposes retained idle and active sessions exactly once", async (t) => {
  await t.test("idle retained session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-abort-retained-idle-"));
    try {
      const abortController = new AbortController();
      const sessions: SequentialFakeSession[] = [];
      const result = await runCoordinator({
        cwd,
        runId: "abort-retained-idle",
        inputText: generatedTodoMarkdown(["Finish before abort", "Remain pending"]),
        commit: false,
        taskTimeoutMs: 0,
        abortSignal: abortController.signal,
        workerSessionFactory: countingFactory(sessions),
        onProgress: (update) => {
          if (update.phase === "task_done") abortController.abort(new Error("stop while retained idle"));
        },
      });
      assert.equal(result.status, "partial");
      assert.equal(result.completedTasks, 1);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.disposeCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await t.test("active retained session", async () => {
    class ActiveUntilAbortSession implements WorkerSessionLike {
      abortCalls = 0;
      disposeCalls = 0;
      private readonly abortController: AbortController;

      constructor(abortController: AbortController) {
        this.abortController = abortController;
      }

      subscribe(): () => void {
        return () => {};
      }

      async prompt(): Promise<void> {
        queueMicrotask(() => this.abortController.abort(new Error("stop active worker")));
        await new Promise<void>(() => {});
      }

      abort(): void {
        this.abortCalls += 1;
      }

      dispose(): void {
        this.disposeCalls += 1;
      }
    }

    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-abort-retained-active-"));
    try {
      const abortController = new AbortController();
      const session = new ActiveUntilAbortSession(abortController);
      const result = await runCoordinator({
        cwd,
        runId: "abort-retained-active",
        inputText: generatedTodoMarkdown(["Abort active task"]),
        commit: false,
        taskTimeoutMs: 0,
        abortSignal: abortController.signal,
        workerSessionFactory: async () => ({ session }),
      });
      assert.equal(result.status, "failed");
      assert.equal(result.outcomes.length, 1);
      assert.equal(result.outcomes[0]?.aborted, true);
      assert.equal(session.abortCalls, 1);
      assert.equal(session.disposeCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("reuse-disabled coordinator creates and disposes one session per task", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-isolated-worker-"));
  try {
    const created: SequentialFakeSession[] = [];
    const result = await runCoordinator({
      cwd,
      runId: "isolated",
      inputText: generatedTodoMarkdown(["First isolated task", "Second isolated task"]),
      commit: false,
      taskTimeoutMs: 0,
      workerSessionReuse: false,
      workerSessionFactory: countingFactory(created),
    });

    assert.equal(result.status, "done");
    assert.equal(created.length, 2);
    assert.deepEqual(
      created.map((session) => session.disposeCalls),
      [1, 1],
    );
    assert.deepEqual(
      created.map((session) => session.prompts.length),
      [1, 1],
    );
    assert.equal(
      created.every((session) => !session.prompts[0].includes("Pi Long Task assignment boundary:")),
      true,
    );
    assert.deepEqual(result.workerSessionMetrics, {
      starts: 2,
      reuses: 0,
      rotations: 2,
      retained: 0,
      rotationReasons: { reuse_disabled: 2 },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
