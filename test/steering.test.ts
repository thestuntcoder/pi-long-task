import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import registerPiLongTaskExtension, { handleLongTaskInput } from "../src/index.ts";
import { ActiveLongTaskSteeringRouter, SerializedSteeringQueue } from "../src/steering.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";

const observed: Array<{ sequence: number; text: string; active: number }> = [];
let activeProcessors = 0;
let maxActiveProcessors = 0;
const queue = new SerializedSteeringQueue({
  queueId: "run-a",
  now: () => new Date("2026-08-31T00:00:00.000Z"),
});
queue.setProcessor(async (message) => {
  activeProcessors += 1;
  maxActiveProcessors = Math.max(maxActiveProcessors, activeProcessors);
  await new Promise((resolve) => setTimeout(resolve, message.sequence === 1 ? 15 : 1));
  observed.push({ sequence: message.sequence, text: message.text, active: activeProcessors });
  activeProcessors -= 1;
});

const first = queue.enqueue("  revise the API task  ", "interactive");
const second = queue.enqueue("then add a migration task", "rpc");
const third = queue.enqueue("finally update verification", "interactive");
assert.equal(first.status, "queued");
assert.deepEqual([first.id, second.id, third.id], ["run-a:1", "run-a:2", "run-a:3"]);
await queue.waitForIdle();
assert.equal(maxActiveProcessors, 1);
assert.deepEqual(
  observed.map(({ sequence, text }) => ({ sequence, text })),
  [
    { sequence: 1, text: "revise the API task" },
    { sequence: 2, text: "then add a migration task" },
    { sequence: 3, text: "finally update verification" },
  ],
);
assert.deepEqual(queue.pendingMessages(), []);

// Capture may begin before the revision consumer is ready. The active plan is
// not touched while guidance is merely queued or while acceptance is pending.
const lateQueue = new SerializedSteeringQueue({ queueId: "late-consumer" });
const activePlan = { revision: 1, text: "original plan" };
lateQueue.enqueue("change a pending task", "interactive");
assert.deepEqual(activePlan, { revision: 1, text: "original plan" });
assert.equal(lateQueue.pendingMessages()[0]?.status, "queued");
let acceptRevision: (() => void) | undefined;
const revisionAccepted = new Promise<void>((resolve) => {
  acceptRevision = resolve;
});
lateQueue.setProcessor(async () => {
  await revisionAccepted;
  activePlan.revision = 2;
  activePlan.text = "accepted revised plan";
});
assert.deepEqual(activePlan, { revision: 1, text: "original plan" });
acceptRevision?.();
await lateQueue.waitForIdle();
assert.deepEqual(activePlan, { revision: 2, text: "accepted revised plan" });
assert.deepEqual(lateQueue.pendingMessages(), []);

const attempts: number[] = [];
let allowFirst = false;
const recoverableQueue = new SerializedSteeringQueue({ queueId: "recoverable" });
recoverableQueue.setProcessor((message) => {
  attempts.push(message.sequence);
  if (message.sequence === 1 && !allowFirst) {
    throw new Error("revision validation failed");
  }
});
recoverableQueue.enqueue("first", "interactive");
recoverableQueue.enqueue("second", "interactive");
await recoverableQueue.waitForIdle();
assert.deepEqual(attempts, [1]);
assert.deepEqual(
  recoverableQueue.pendingMessages().map(({ sequence, status, error }) => ({ sequence, status, error })),
  [
    { sequence: 1, status: "failed", error: "revision validation failed" },
    { sequence: 2, status: "queued", error: undefined },
  ],
);
allowFirst = true;
recoverableQueue.retryFailed();
await recoverableQueue.waitForIdle();
assert.deepEqual(attempts, [1, 1, 2]);
assert.deepEqual(recoverableQueue.pendingMessages(), []);

const router = new ActiveLongTaskSteeringRouter();
assert.deepEqual(router.route({ text: "normal message", source: "interactive", streamingBehavior: "steer" }), {
  routed: false,
  reason: "no_active_run",
});
const routedQueue = new SerializedSteeringQueue({ queueId: "active" });
const deactivate = router.activate(routedQueue);

assert.deepEqual(router.route({ text: "/cancel", source: "interactive", streamingBehavior: "steer" }), {
  routed: false,
  reason: "control_input",
});
assert.deepEqual(router.route({ text: "!git status", source: "interactive", streamingBehavior: "steer" }), {
  routed: false,
  reason: "control_input",
});
assert.deepEqual(router.route({ text: "later", source: "interactive", streamingBehavior: "followUp" }), {
  routed: false,
  reason: "not_steering",
});
assert.deepEqual(router.route({ text: "generated", source: "extension", streamingBehavior: "steer" }), {
  routed: false,
  reason: "not_steering",
});
assert.deepEqual(
  router.route({ text: "look at this", source: "interactive", streamingBehavior: "steer", images: [{}] }),
  { routed: false, reason: "images" },
);

const notifications: Array<{ message: string; level?: string }> = [];
const inputContext = {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error") {
      notifications.push({ message, level });
    },
  },
};
assert.deepEqual(
  handleLongTaskInput(
    { text: "Put accessibility checks before docs", source: "interactive", streamingBehavior: "steer" },
    inputContext,
    router,
  ),
  { action: "handled" },
);
assert.equal(routedQueue.pendingMessages().length, 1);
assert.equal(routedQueue.pendingMessages()[0]?.text, "Put accessibility checks before docs");
assert.equal(notifications.length, 1);
assert.match(notifications[0]?.message ?? "", /Guidance received.*queued for incorporation/i);
assert.equal(notifications[0]?.level, "info");

assert.deepEqual(
  handleLongTaskInput({ text: "/cancel", source: "interactive", streamingBehavior: "steer" }, inputContext, router),
  { action: "continue" },
);
assert.deepEqual(
  handleLongTaskInput(
    { text: "Run a long task to update docs", source: "interactive", streamingBehavior: "followUp" },
    inputContext,
    router,
  ).action,
  "transform",
);
assert.deepEqual(handleLongTaskInput({ text: "ordinary idle behavior", source: "interactive" }, inputContext, router), {
  action: "continue",
});

deactivate();
assert.deepEqual(router.route({ text: "after run", source: "interactive", streamingBehavior: "steer" }), {
  routed: false,
  reason: "no_active_run",
});

// Exercise the extension registration path while pi_long_task is actually
// executing. A pre-aborted run stays worker-free but remains active across the
// coordinator's first filesystem await, where the input event is submitted.
type RegisteredInputHandler = (
  event: {
    text: string;
    source: "interactive" | "rpc" | "extension";
    streamingBehavior?: "steer" | "followUp";
  },
  ctx: typeof inputContext,
) => unknown;
type RegisteredLongTaskExecute = (
  toolCallId: string,
  params: { inputText?: string; commit: boolean; goal?: string },
  signal: AbortSignal,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<unknown>;
let registeredInputHandler: RegisteredInputHandler | undefined;
let registeredLongTaskExecute: RegisteredLongTaskExecute | undefined;
registerPiLongTaskExtension({
  on(event: string, handler: unknown) {
    if (event === "input") {
      registeredInputHandler = handler as RegisteredInputHandler;
    }
  },
  registerTool(tool: { name?: string; execute?: unknown }) {
    if (tool.name === "pi_long_task") {
      registeredLongTaskExecute = tool.execute as RegisteredLongTaskExecute;
    }
  },
} as unknown as Parameters<typeof registerPiLongTaskExtension>[0]);
assert.ok(registeredInputHandler);
assert.ok(registeredLongTaskExecute);

const integrationRoot = await mkdtemp(path.join(os.tmpdir(), "pi-long-task-steering-"));
try {
  const abortController = new AbortController();
  abortController.abort();
  const execution = registeredLongTaskExecute(
    "active-tool-call",
    { inputText: generatedTodoMarkdown(["Worker remains pending"]), commit: false },
    abortController.signal,
    undefined,
    {
      cwd: integrationRoot,
      model: undefined,
      hasUI: false,
      ui: inputContext.ui,
    },
  );
  const activeInputResult = registeredInputHandler(
    {
      text: "Add integration verification before completion",
      source: "interactive",
      streamingBehavior: "steer",
    },
    inputContext,
  );
  assert.deepEqual(activeInputResult, { action: "handled" });
  assert.match(notifications.at(-1)?.message ?? "", /Guidance received.*incorporation/i);
  await execution;

  assert.deepEqual(
    registeredInputHandler(
      { text: "No active run now", source: "interactive", streamingBehavior: "steer" },
      inputContext,
    ),
    { action: "continue" },
  );
} finally {
  await rm(integrationRoot, { recursive: true, force: true });
}

const secondQueue = new SerializedSteeringQueue({ queueId: "other" });
const deactivateFirst = router.activate(routedQueue);
const deactivateSecond = router.activate(secondQueue);
assert.deepEqual(router.route({ text: "ambiguous", source: "interactive", streamingBehavior: "steer" }), {
  routed: false,
  reason: "ambiguous_active_runs",
});
deactivateFirst();
deactivateSecond();
