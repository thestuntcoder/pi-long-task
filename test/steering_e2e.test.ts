import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinator, type CoordinatorProgressUpdate } from "../src/coordinator.ts";
import { handleLongTaskInput } from "../src/index.ts";
import { ActiveLongTaskSteeringRouter, SerializedSteeringQueue } from "../src/steering.ts";
import { parseTasks, type Task } from "../src/todo_parser.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

interface TaskSpec {
  title: string;
  stableId: string;
  status?: string;
  done?: boolean;
}

function todo(specs: readonly TaskSpec[]): string {
  const progress = specs
    .map((spec, index) => `- [${spec.done ? "x" : " "}] TODO ${index + 1} — ${spec.title}`)
    .join("\n");
  const sections = specs
    .map(
      (spec, index) => `## TODO ${index + 1} — ${spec.title}
<!-- pi-long-task-id: ${spec.stableId} -->

**Goal:** Complete ${spec.title}.

**Status:**
- [${spec.done ? "x" : " "}] ${spec.status ?? `Implement ${spec.title}`}

**Verify:**
- Run focused tests.

**Done when:** ${spec.title} is complete.`,
    )
    .join("\n\n");
  return `# Pi Long Task TODO

Global instructions:
- Continue from accepted revisions without restarting completed work.

## Progress

${progress}

---

${sections}
`;
}

function completedOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: `start-${options.task.taskId}-${options.attempt}`,
    endedAt: `end-${options.task.taskId}-${options.attempt}`,
    reportedStatus: "done",
    done: true,
    assistantText: `TASK_RESULT:\nstatus: done\nsummary: completed ${options.task.title}\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

function taskShape(tasks: readonly Task[]): Array<[string, string, boolean]> {
  return tasks.map((task) => [task.stableId ?? "", task.title, task.done]);
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-steering-e2e-"));
try {
  // Exercise the user input route through revision planning, reconciliation,
  // rendering/persistence, and scheduling. Two rapid messages must be applied
  // once and in order before the scheduler selects more work.
  const queue = new SerializedSteeringQueue({ queueId: "full-workflow" });
  const router = new ActiveLongTaskSteeringRouter();
  const deactivate = router.activate(queue);
  const notifications: string[] = [];
  const inputContext = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  const calls: Array<{ title: string; status: string }> = [];
  const plannerGuidance: string[] = [];
  const updates: CoordinatorProgressUpdate[] = [];
  let guidanceSubmitted = false;

  const run = await runCoordinator({
    inputText: todo([
      { title: "Foundation", stableId: "foundation" },
      { title: "Build API", stableId: "api", status: "Implement the REST API" },
      { title: "Write docs", stableId: "docs" },
    ]),
    commit: false,
    cwd: root,
    runId: "full-workflow",
    steeringQueue: queue,
    todoPlanner: async (options) => {
      assert.ok(options.planRevision);
      plannerGuidance.push(options.planRevision.guidance);
      if (plannerGuidance.length === 1) {
        assert.equal(options.planRevision.relevantResults[0]?.taskId, "1");
        assert.match(options.planRevision.relevantResults[0]?.summary ?? "", /completed Foundation/);
        return todo([
          // Deliberately unchecked: reconciliation, not the planner, preserves completion.
          { title: "Foundation", stableId: "foundation" },
          { title: "Accessibility review", stableId: "accessibility" },
          { title: "Write docs", stableId: "docs" },
          { title: "Build API", stableId: "api", status: "Implement the REST API with pagination" },
        ]);
      }

      assert.deepEqual(
        parseTasks(options.planRevision.currentTodoMarkdown).map((task) => task.title),
        ["Foundation", "Accessibility review", "Write docs", "Build API"],
      );
      return todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Accessibility review", stableId: "accessibility" },
        { title: "Security review", stableId: "security" },
        { title: "Write docs", stableId: "docs", status: "Document pagination with examples" },
        { title: "Build API", stableId: "api", status: "Implement the REST API with pagination" },
      ]);
    },
    workerRunner: async (options) => {
      calls.push({
        title: options.task.title,
        status: options.task.section,
      });
      return completedOutcome(options);
    },
    onProgress: (update) => {
      updates.push(update);
      if (update.phase === "task_done" && update.title === "Foundation" && !guidanceSubmitted) {
        guidanceSubmitted = true;
        const first = handleLongTaskInput(
          {
            text: "Add accessibility before docs, move docs before API, and add pagination to API.",
            source: "interactive",
            streamingBehavior: "steer",
          },
          inputContext,
          router,
        );
        const second = handleLongTaskInput(
          {
            text: "Then insert security after accessibility and require examples in docs.",
            source: "rpc",
            streamingBehavior: "steer",
          },
          inputContext,
          router,
        );
        assert.deepEqual(first, { action: "handled" });
        assert.deepEqual(second, { action: "handled" });
      }
    },
  });
  deactivate();

  assert.equal(run.status, "done");
  assert.deepEqual(plannerGuidance, [
    "Add accessibility before docs, move docs before API, and add pagination to API.",
    "Then insert security after accessibility and require examples in docs.",
  ]);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0] ?? "", /Guidance received.*#1/i);
  assert.match(notifications[1] ?? "", /Guidance received.*#2/i);
  assert.deepEqual(
    calls.map((call) => call.title),
    ["Foundation", "Accessibility review", "Security review", "Write docs", "Build API"],
  );
  assert.equal(calls.filter((call) => call.title === "Foundation").length, 1);
  assert.match(calls.find((call) => call.title === "Write docs")?.status ?? "", /pagination with examples/i);
  assert.match(calls.find((call) => call.title === "Build API")?.status ?? "", /REST API with pagination/i);

  const revisionUpdates = updates.filter((update) => update.phase === "planned" && update.status === "revised");
  assert.equal(revisionUpdates.length, 2);
  assert.deepEqual(
    revisionUpdates.map((update) => update.taskProgress?.tasks.map((task) => [task.title, task.done])),
    [
      [
        ["Foundation", true],
        ["Accessibility review", false],
        ["Write docs", false],
        ["Build API", false],
      ],
      [
        ["Foundation", true],
        ["Accessibility review", false],
        ["Security review", false],
        ["Write docs", false],
        ["Build API", false],
      ],
    ],
  );

  const persistedTasks = parseTasks(await readFile(run.todoPath, "utf8"));
  assert.deepEqual(taskShape(persistedTasks), [
    ["foundation", "Foundation", true],
    ["accessibility", "Accessibility review", true],
    ["security", "Security review", true],
    ["docs", "Write docs", true],
    ["api", "Build API", true],
  ]);
  assert.deepEqual(
    run.taskProgress.tasks.map((task) => [task.taskId, task.title, task.done]),
    persistedTasks.map((task) => [task.taskId, task.title, task.done]),
  );
  assert.equal(run.taskProgress.summary.totalTasks, persistedTasks.length);
  assert.equal(run.taskProgress.summary.completedTasks, persistedTasks.filter((task) => task.done).length);
  for (const task of persistedTasks) {
    assert.equal(task.progressDone, task.done, `${task.title} progress rendering must match scheduler state`);
    assert.equal(
      task.statusCheckboxes.every((done) => done === task.done),
      true,
      `${task.title} section rendering must match scheduler state`,
    );
  }

  // Invalid planner output is rejected end to end. The old plan remains
  // authoritative and usable, and normal scheduling finishes it.
  const invalidQueue = new SerializedSteeringQueue({ queueId: "invalid-workflow" });
  const invalidRouter = new ActiveLongTaskSteeringRouter();
  const deactivateInvalid = invalidRouter.activate(invalidQueue);
  const invalidCalls: string[] = [];
  const invalidUpdates: CoordinatorProgressUpdate[] = [];
  let invalidSubmitted = false;
  const invalidRun = await runCoordinator({
    inputText: todo([
      { title: "Keep first", stableId: "keep-first" },
      { title: "Keep second", stableId: "keep-second" },
    ]),
    commit: false,
    cwd: root,
    runId: "invalid-workflow",
    steeringQueue: invalidQueue,
    todoPlanner: async () => "not a valid TODO plan",
    workerRunner: async (options) => {
      invalidCalls.push(options.task.title);
      if (!invalidSubmitted) {
        invalidSubmitted = true;
        assert.deepEqual(
          handleLongTaskInput(
            {
              text: "Replace the remaining plan with an invalid revision.",
              source: "interactive",
              streamingBehavior: "steer",
            },
            inputContext,
            invalidRouter,
          ),
          { action: "handled" },
        );
        await invalidQueue.waitForIdle();
      }
      return completedOutcome(options);
    },
    onProgress: (update) => invalidUpdates.push(update),
  });
  deactivateInvalid();

  assert.equal(invalidRun.status, "done");
  assert.deepEqual(invalidCalls, ["Keep first", "Keep second"]);
  assert.equal(invalidQueue.pendingMessages()[0]?.status, "failed");
  assert.equal(invalidUpdates.filter((update) => update.status === "revision_failed").length, 1);
  const invalidPersisted = parseTasks(await readFile(invalidRun.todoPath, "utf8"));
  assert.deepEqual(taskShape(invalidPersisted), [
    ["keep-first", "Keep first", true],
    ["keep-second", "Keep second", true],
  ]);
  assert.deepEqual(
    invalidRun.taskProgress.tasks.map((task) => [task.title, task.done]),
    invalidPersisted.map((task) => [task.title, task.done]),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
