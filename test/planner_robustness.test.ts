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
    await assert.rejects(plannerPromise, /TODO planner aborted: stop planning/);
    assert.equal(abortCalls, 1);
    assert.equal(disposeCalls, 1);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.kind),
      ["abort"],
    );
    assert.equal(diagnostics[0]?.sessionId, "abort-session");
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
