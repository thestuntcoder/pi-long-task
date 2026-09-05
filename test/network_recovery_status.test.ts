import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, type CoordinatorProgressUpdate, type TodoPlanner } from "../src/coordinator.ts";
import type { NetworkRecoveryEvent } from "../src/network_recovery.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

const doneText =
  "TASK_RESULT:\nstatus: done\nsummary: recovered\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none";

function outcome(options: RunWorkerTaskOptions, error?: Error): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-05T00:00:00.000Z",
    endedAt: "2026-09-05T00:00:01.000Z",
    reportedStatus: error ? "failed" : "done",
    done: !error,
    assistantText: error ? "" : doneText,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
    error: error?.message,
    failure: error,
  };
}

async function withTempDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-network-status-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("worker recovery publishes each retry and restores the active task status", async () => {
  await withTempDir(async (cwd) => {
    const updates: CoordinatorProgressUpdate[] = [];
    const recoveryEvents: NetworkRecoveryEvent[] = [];
    let calls = 0;
    const result = await runCoordinator({
      cwd,
      runId: "status-retries",
      inputText: generatedTodoMarkdown(["Recover visibly"]),
      commit: false,
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 500 },
      workerRunner: async (options) => {
        calls += 1;
        return calls < 3
          ? outcome(options, Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }))
          : outcome(options);
      },
      onProgress: (update) => updates.push(update),
      onNetworkRecovery: (event) => recoveryEvents.push(event),
    });

    assert.equal(result.status, "done");
    assert.equal(result.attemptedTasks, 1);
    const waiting = updates.filter((update) => update.phase === "network_wait");
    assert.deepEqual(
      waiting.map((update) => update.networkRecoveryEvent),
      ["outage_started", "retry_scheduled", "retry_started", "retry_failed", "retry_scheduled", "retry_started"],
    );
    assert.match(waiting[1]?.message ?? "", /^Waiting for connection… retry 1 in /);
    assert.match(waiting[3]?.message ?? "", /retry 1 failed/);
    assert.equal(waiting[4]?.networkRetryCount, 2);
    assert.equal(typeof waiting[4]?.networkNextRetryInMs, "number");
    assert.equal(
      waiting.every((update) => update.taskId === "1"),
      true,
    );

    const lastWaitingIndex = updates.map((update) => update.phase).lastIndexOf("network_wait");
    assert.equal(updates[lastWaitingIndex + 1]?.phase, "task_start", "recovery must restore the task status");
    assert.match(updates[lastWaitingIndex + 1]?.message ?? "", /Running TODO 1/);
    assert.equal(updates.at(-1)?.phase, "complete");
    assert.equal(recoveryEvents.filter((event) => event.type === "cleanup").length, 1);
  });
});

test("planner recovery restores planning before publishing the completed plan", async () => {
  await withTempDir(async (cwd) => {
    const updates: CoordinatorProgressUpdate[] = [];
    let calls = 0;
    const planner: TodoPlanner = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError("temporary DNS failure"), { code: "EAI_AGAIN" });
      return generatedTodoMarkdown(["Execute recovered plan"]);
    };

    const result = await runCoordinator({
      cwd,
      runId: "status-planner",
      inputText: "Plan this request after connectivity returns.",
      commit: false,
      todoPlanner: planner,
      workerRunner: async (options) => outcome(options),
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 500 },
      onProgress: (update) => updates.push(update),
    });

    assert.equal(result.status, "done");
    const lastWait = updates.map((update) => update.phase).lastIndexOf("network_wait");
    assert.ok(lastWait >= 0);
    assert.equal(updates[lastWait + 1]?.phase, "planning");
    assert.equal(updates[lastWait + 2]?.phase, "planned");
  });
});

test("outage expiry removes waiting status through the terminal failure path", async () => {
  await withTempDir(async (cwd) => {
    const updates: CoordinatorProgressUpdate[] = [];
    const events: NetworkRecoveryEvent[] = [];
    const result = await runCoordinator({
      cwd,
      runId: "status-expiry",
      inputText: generatedTodoMarkdown(["Expire visibly"]),
      commit: false,
      workerRunner: async (options) =>
        outcome(options, Object.assign(new TypeError("still offline"), { code: "ECONNRESET" })),
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 1 },
      onProgress: (update) => updates.push(update),
      onNetworkRecovery: (event) => events.push(event),
    });

    assert.equal(result.status, "failed");
    assert.equal(
      updates.some((update) => update.networkRecoveryEvent === "expiry_scheduled"),
      true,
    );
    assert.match(
      updates.find((update) => update.networkRecoveryEvent === "expiry_scheduled")?.message ?? "",
      /recovery window expires/,
    );
    assert.equal(events.filter((event) => event.type === "outage_expired").length, 1);
    assert.equal(events.filter((event) => event.type === "cleanup").length, 1);
    assert.equal(updates.at(-1)?.phase, "complete");
    assert.equal(updates.at(-1)?.status, "failed");
  });
});

test("cancellation during recovery sleep is prompt, cleans once, and cannot publish stale status", async () => {
  await withTempDir(async (cwd) => {
    const controller = new AbortController();
    const updates: CoordinatorProgressUpdate[] = [];
    const events: NetworkRecoveryEvent[] = [];
    let cancellationRequests = 0;

    const run = runCoordinator({
      cwd,
      runId: "status-cancel",
      inputText: generatedTodoMarkdown(["Cancel visibly"]),
      commit: false,
      abortSignal: controller.signal,
      workerRunner: async (options) =>
        outcome(options, Object.assign(new TypeError("offline"), { code: "ECONNRESET" })),
      networkRecovery: { enabled: true, baseDelayMs: 10_000, maxDelayMs: 10_000, maxOutageMs: null },
      onProgress: (update) => {
        updates.push(update);
        if (update.networkRecoveryEvent === "retry_scheduled" && !controller.signal.aborted) {
          cancellationRequests += 1;
          controller.abort("user cancelled outage wait");
        }
      },
      onNetworkRecovery: (event) => events.push(event),
    });

    const result = await run;
    assert.equal(result.status, "failed");
    assert.equal(cancellationRequests, 1);
    assert.equal(events.filter((event) => event.type === "cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "cleanup").length, 1);
    assert.equal(updates.at(-1)?.phase, "complete");
    const countAtCompletion = updates.length;
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(updates.length, countAtCompletion, "no status may be published after terminal completion");
  });
});
