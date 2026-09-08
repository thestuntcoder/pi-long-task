import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, runTodoPlanner, type PlannerDiagnostic } from "../src/coordinator.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome, WorkerSessionFactory } from "../src/worker_session.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-long-task-planner-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function outcomeFor(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: `start-${options.task.taskId}-${options.attempt}`,
    endedAt: `end-${options.task.taskId}-${options.attempt}`,
    reportedStatus: "done",
    done: true,
    assistantText: `TASK_RESULT:\nstatus: done\nsummary: ${options.task.taskId}/${options.attempt}\nchanges:\n- none\nverification:\n- not run\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

function queuedPlannerSession(outputs: readonly string[]): {
  factory: WorkerSessionFactory;
  prompts: string[];
  disposeCalls: () => number;
} {
  const prompts: string[] = [];
  let disposeCount = 0;

  return {
    prompts,
    disposeCalls: () => disposeCount,
    factory: async () => ({
      session: {
        sessionId: "planner-session",
        sessionFile: "planner.session.json",
        async prompt(text) {
          prompts.push(text);
        },
        getLastAssistantText: () => outputs[Math.min(prompts.length, outputs.length) - 1] ?? "",
        subscribe: () => () => {},
        dispose: () => {
          disposeCount += 1;
        },
      },
    }),
  };
}

test("planner success path creates work and disposes the planner session", async () => {
  await withTempDir(async (cwd) => {
    const planner = queuedPlannerSession([generatedTodoMarkdown(["Planned success task"])]);
    const workerCalls: string[] = [];

    const result = await runCoordinator({
      inputText: "Plan one task from this product request.",
      commit: false,
      cwd,
      runId: "planner-success",
      todoSessionFactory: planner.factory,
      workerRunner: async (options) => {
        workerCalls.push(`${options.task.taskId}:${options.attempt}`);
        return outcomeFor(options);
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.completedTasks, 1);
    assert.deepEqual(workerCalls, ["1:1"]);
    assert.equal(planner.prompts.length, 1);
    assert.equal(planner.disposeCalls(), 1);
  });
});

test("planner timeout aborts and disposes the planner session", async () => {
  await withTempDir(async (cwd) => {
    const diagnostics: PlannerDiagnostic[] = [];
    let abortCalls = 0;
    let disposeCalls = 0;
    let resolvePromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan a task that times out.",
      cwd,
      runDir: path.join(cwd, "planner-timeout"),
      thinkingLevel: "xhigh",
      timeoutMs: 10,
      gracefulShutdownMs: 0,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({
        session: {
          sessionId: "timeout-session",
          async prompt() {
            resolvePromptStarted?.();
            await new Promise<void>(() => {});
          },
          subscribe: () => () => {},
          abort: () => {
            abortCalls += 1;
          },
          dispose: () => {
            disposeCalls += 1;
          },
        },
      }),
    });

    await promptStarted;
    await assert.rejects(plannerPromise, /TODO planner timed out/);
    assert.equal(abortCalls, 1);
    assert.equal(disposeCalls, 1);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.kind),
      ["timeout"],
    );
    assert.equal(diagnostics[0]?.sessionId, "timeout-session");
  });
});

class GracePeriodPlannerSession {
  sessionId = "grace-period-planner";
  messages: unknown[] = [];
  followUps: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly output?: string;
  private readonly outputDelayMs?: number;
  private readonly completeMessage: boolean;
  private resolvePrompt: (() => void) | undefined;
  private resolvePromptStarted: (() => void) | undefined;
  readonly promptStarted = new Promise<void>((resolve) => {
    this.resolvePromptStarted = resolve;
  });

  constructor(options: { output?: string; outputDelayMs?: number; completeMessage?: boolean }) {
    this.output = options.output;
    this.outputDelayMs = options.outputDelayMs;
    this.completeMessage = options.completeMessage ?? true;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(): Promise<void> {
    if (this.output !== undefined && this.outputDelayMs === undefined) {
      this.emitText(this.output);
    }
    this.resolvePromptStarted?.();
    await new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
    if (this.output === undefined || this.outputDelayMs === undefined) {
      return;
    }
    setTimeout(() => {
      this.emitText(this.output ?? "");
      this.resolvePrompt?.();
    }, this.outputDelayMs);
  }

  abort(): void {
    this.abortCalls += 1;
    this.resolvePrompt?.();
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  getLastAssistantText(): string | undefined {
    const message = this.messages.at(-1);
    if (typeof message !== "object" || message === null || !("content" in message)) {
      return undefined;
    }
    return typeof message.content === "string" ? message.content : undefined;
  }

  private emitText(text: string): void {
    const message = { role: "assistant", content: text };
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    if (this.completeMessage) {
      this.messages.push(message);
      this.emit({ type: "message_end", message });
    }
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

test("planner accepts valid completed output during grace using a fake clock", async (t) => {
  await withTempDir(async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const diagnostics: PlannerDiagnostic[] = [];
    const session = new GracePeriodPlannerSession({
      output: generatedTodoMarkdown(["Grace period success"]),
      outputDelayMs: 5,
    });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan one task during grace.",
      cwd,
      runDir: path.join(cwd, "planner-grace-success"),
      timeoutMs: 10,
      gracefulShutdownMs: 20,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({ session }),
    });

    await session.promptStarted;
    t.mock.timers.tick(10);
    assert.equal(session.followUps.length, 1);
    t.mock.timers.tick(5);

    const markdown = await plannerPromise;
    assert.match(markdown, /TODO 1 — Grace period success/);
    assert.equal(session.abortCalls, 0);
    assert.equal(session.disposeCalls, 1);
    assert.deepEqual(diagnostics, []);
  });
});

test("planner rejects invalid output that completes during grace using a fake clock", async (t) => {
  await withTempDir(async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const diagnostics: PlannerDiagnostic[] = [];
    const session = new GracePeriodPlannerSession({
      output: "# Pi Long Task TODO\n\ntruncated",
      outputDelayMs: 5,
    });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan one task but finish with invalid output.",
      cwd,
      runDir: path.join(cwd, "planner-invalid-grace"),
      timeoutMs: 10,
      gracefulShutdownMs: 20,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({ session }),
    });

    await session.promptStarted;
    t.mock.timers.tick(10);
    t.mock.timers.tick(5);

    await assert.rejects(plannerPromise, /TODO planner timed out \(partial output observed; content omitted\)/);
    assert.equal(session.abortCalls, 0);
    assert.equal(diagnostics[0]?.partialOutputObserved, true);
  });
});

test("planner timeout reports partial output without leaking it using a fake clock", async (t) => {
  await withTempDir(async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const diagnostics: PlannerDiagnostic[] = [];
    const unsafePartial = "# Pi Long Task TODO\n\nSECRET-TRUNCATED-CONTENT";
    const session = new GracePeriodPlannerSession({ output: unsafePartial, completeMessage: false });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan one task but emit only a fragment.",
      cwd,
      runDir: path.join(cwd, "planner-partial-timeout"),
      timeoutMs: 10,
      gracefulShutdownMs: 20,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({ session }),
    });

    await session.promptStarted;
    t.mock.timers.tick(10);
    t.mock.timers.tick(20);

    await assert.rejects(plannerPromise, /TODO planner timed out \(partial output observed; content omitted\)/);
    assert.equal(session.abortCalls, 1);
    assert.equal(diagnostics[0]?.kind, "timeout");
    assert.equal(diagnostics[0]?.partialOutputObserved, true);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET-TRUNCATED-CONTENT/);
  });
});

test("planner timeout distinguishes no output using a fake clock", async (t) => {
  await withTempDir(async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const diagnostics: PlannerDiagnostic[] = [];
    const session = new GracePeriodPlannerSession({});

    const plannerPromise = runTodoPlanner({
      inputText: "Plan one task but emit nothing.",
      cwd,
      runDir: path.join(cwd, "planner-no-output-timeout"),
      timeoutMs: 10,
      gracefulShutdownMs: 20,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({ session }),
    });

    await session.promptStarted;
    t.mock.timers.tick(10);
    t.mock.timers.tick(20);

    await assert.rejects(plannerPromise, /TODO planner timed out \(no planner output observed\)/);
    assert.equal(session.abortCalls, 1);
    assert.equal(diagnostics[0]?.kind, "timeout");
    assert.equal(diagnostics[0]?.partialOutputObserved, false);
  });
});

test("planner abort aborts and disposes the planner session", async () => {
  await withTempDir(async (cwd) => {
    const abortController = new AbortController();
    const diagnostics: PlannerDiagnostic[] = [];
    let abortCalls = 0;
    let disposeCalls = 0;
    let resolvePromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan a task that will be aborted.",
      cwd,
      runDir: path.join(cwd, "planner-abort"),
      thinkingLevel: "xhigh",
      abortSignal: abortController.signal,
      timeoutMs: 1_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({
        session: {
          sessionId: "abort-session",
          async prompt() {
            resolvePromptStarted?.();
            await new Promise<void>(() => {});
          },
          subscribe: () => () => {},
          abort: () => {
            abortCalls += 1;
          },
          dispose: () => {
            disposeCalls += 1;
          },
        },
      }),
    });

    await promptStarted;
    abortController.abort(new Error("stop planning"));
    await assert.rejects(plannerPromise, /TODO planner cancelled \(no planner output observed\): stop planning/);
    assert.equal(abortCalls, 1);
    assert.equal(disposeCalls, 1);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.kind),
      ["cancelled"],
    );
    assert.equal(diagnostics[0]?.sessionId, "abort-session");
    assert.equal(diagnostics[0]?.partialOutputObserved, false);
  });
});

test("planner cancellation during grace wins over timeout and retains partial-output metadata", async (t) => {
  await withTempDir(async (cwd) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const diagnostics: PlannerDiagnostic[] = [];
    const session = new GracePeriodPlannerSession({
      output: "# Pi Long Task TODO\n\npartial cancellation output",
      completeMessage: false,
    });

    const plannerPromise = runTodoPlanner({
      inputText: "Plan until cancellation during grace.",
      cwd,
      runDir: path.join(cwd, "planner-grace-cancel"),
      abortSignal: controller.signal,
      timeoutMs: 10,
      gracefulShutdownMs: 100,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionFactory: async () => ({ session }),
    });

    await session.promptStarted;
    t.mock.timers.tick(10);
    assert.equal(session.followUps.length, 1);
    controller.abort("user stopped planning during grace");

    await assert.rejects(plannerPromise, /TODO planner cancelled \(partial output observed; content omitted\)/);
    assert.equal(session.abortCalls, 1);
    assert.equal(session.disposeCalls, 1);
    assert.equal(diagnostics[0]?.kind, "cancelled");
    assert.equal(diagnostics[0]?.partialOutputObserved, true);
  });
});

test("planner invalid-output repair succeeds and disposes the planner session", async () => {
  await withTempDir(async (cwd) => {
    const planner = queuedPlannerSession([
      "This is not Pi Long Task TODO markdown.",
      generatedTodoMarkdown(["Repaired planner output"]),
    ]);
    const diagnostics: PlannerDiagnostic[] = [];

    const markdown = await runTodoPlanner({
      inputText: "Plan a task after a bad first response.",
      cwd,
      runDir: path.join(cwd, "planner-repair"),
      thinkingLevel: "xhigh",
      sessionFactory: planner.factory,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    assert.match(markdown, /TODO 1 — Repaired planner output/);
    assert.equal(planner.prompts.length, 2);
    assert.match(planner.prompts[1], /Validation\/extraction error:/);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.kind),
      ["invalid_output", "repair_attempt"],
    );
    assert.equal(planner.disposeCalls(), 1);
  });
});

test("planner invalid-output final failure skips workers and disposes the planner session", async () => {
  await withTempDir(async (cwd) => {
    const planner = queuedPlannerSession(["bad first planner output", "bad repaired planner output"]);
    const workerCalls: string[] = [];

    const result = await runCoordinator({
      inputText: "Plan a task but fail to produce valid TODO markdown.",
      commit: false,
      cwd,
      runId: "planner-invalid-final",
      todoSessionFactory: planner.factory,
      workerRunner: async (options) => {
        workerCalls.push(options.task.taskId);
        return outcomeFor(options);
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.attemptedTasks, 0);
    assert.equal(result.outcomes.length, 0);
    assert.deepEqual(workerCalls, []);
    assert.equal(planner.prompts.length, 2);
    assert.equal(planner.disposeCalls(), 1);
    assert.match(result.error ?? "", /TODO planner returned invalid TODO markdown after one repair attempt/);
    assert.ok(result.error?.includes(result.taskResultPath));
  });
});
