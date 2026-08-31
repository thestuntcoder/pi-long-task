import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinator, type CoordinatorProgressUpdate } from "../src/coordinator.ts";
import { SerializedSteeringQueue } from "../src/steering.ts";
import { parseTasks } from "../src/todo_parser.ts";
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
- Continue from accepted revisions.

## Progress

${progress}

---

${sections}
`;
}

function outcomeFor(options: RunWorkerTaskOptions, status = "done"): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: `start-${options.task.taskId}-${options.attempt}`,
    endedAt: `end-${options.task.taskId}-${options.attempt}`,
    reportedStatus: status,
    done: status === "done",
    assistantText: `TASK_RESULT:\nstatus: ${status}\nsummary: output for ${options.task.title}\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-steering-execution-"));
try {
  // A revision accepted after the first completion is consumed at the next
  // scheduler boundary. Completed work remains checked and is not rerun.
  const insertionQueue = new SerializedSteeringQueue({ queueId: "insert-after-complete" });
  const insertionCalls: string[] = [];
  let insertionQueued = false;
  const insertionUpdates: CoordinatorProgressUpdate[] = [];
  const insertionRun = await runCoordinator({
    inputText: todo([
      { title: "Foundation", stableId: "foundation" },
      { title: "Original follow-up", stableId: "follow-up" },
    ]),
    commit: false,
    cwd: root,
    runId: "insert-after-complete",
    steeringQueue: insertionQueue,
    todoPlanner: async (options) => {
      assert.ok(options.planRevision, "steering must use the revision planner context");
      assert.equal(options.planRevision.relevantResults.length, 1);
      assert.equal(options.planRevision.relevantResults[0]?.taskId, "1");
      assert.match(options.planRevision.relevantResults[0]?.summary ?? "", /output for Foundation/);
      return todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Inserted review", stableId: "review" },
        { title: "Original follow-up", stableId: "follow-up" },
      ]);
    },
    workerRunner: async (options) => {
      insertionCalls.push(options.task.title);
      return outcomeFor(options);
    },
    onProgress: (update) => {
      insertionUpdates.push(update);
      if (update.phase === "task_done" && update.title === "Foundation" && !insertionQueued) {
        insertionQueued = true;
        insertionQueue.enqueue("Insert review before the remaining follow-up.", "interactive");
      }
    },
  });

  assert.equal(insertionRun.status, "done");
  assert.deepEqual(insertionCalls, ["Foundation", "Inserted review", "Original follow-up"]);
  assert.equal(insertionCalls.filter((title) => title === "Foundation").length, 1);
  assert.equal(insertionRun.runId, "insert-after-complete");
  assert.equal(insertionRun.completedTasks, 3);
  assert.equal(
    insertionUpdates.some((update) => update.phase === "planned" && update.status === "revised"),
    true,
  );
  assert.deepEqual(
    parseTasks(await readFile(insertionRun.todoPath, "utf8")).map((task) => [task.title, task.done]),
    [
      ["Foundation", true],
      ["Inserted review", true],
      ["Original follow-up", true],
    ],
  );
  const insertionResults = await readFile(insertionRun.taskResultPath, "utf8");
  assert.equal((insertionResults.match(/Foundation \(attempt 1\)/g) ?? []).length, 1);
  assert.match(insertionResults, /summary: output for Foundation/);

  // If steering changes the worker's currently running task, the worker may
  // finish safely, but its terminal result is historical only. It cannot check
  // off, consume a retry for, or otherwise complete the replacement.
  let resolveAccepted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    resolveAccepted = resolve;
  });
  const replacementQueue = new SerializedSteeringQueue({
    queueId: "replace-running",
    onChange: (message) => {
      if (message.status === "accepted") {
        resolveAccepted?.();
      }
    },
  });
  const replacementCalls: Array<{ title: string; status: string; attempt: number }> = [];
  let replacementQueued = false;
  const replacementUpdates: CoordinatorProgressUpdate[] = [];
  const replacementRun = await runCoordinator({
    inputText: todo([
      { title: "Build API", stableId: "api", status: "Implement REST API" },
      { title: "Document API", stableId: "docs" },
    ]),
    commit: false,
    cwd: root,
    runId: "replace-running",
    steeringQueue: replacementQueue,
    todoPlanner: async (options) => {
      assert.equal(options.planRevision?.activeTask?.title, "Build API");
      return todo([
        { title: "Build API", stableId: "api", status: "Replace REST work with GraphQL" },
        { title: "Document API", stableId: "docs" },
      ]);
    },
    workerRunner: async (options) => {
      const status = options.task.section.includes("GraphQL") ? "graphql" : "rest";
      replacementCalls.push({ title: options.task.title, status, attempt: options.attempt });
      if (status === "rest" && !replacementQueued) {
        replacementQueued = true;
        replacementQueue.enqueue("Change the active API task from REST to GraphQL.", "interactive");
        await accepted;
      }
      const outcome = outcomeFor(options);
      return {
        ...outcome,
        // The obsolete REST invocation and its GraphQL replacement both use
        // TODO 1 / attempt 1; accounting must retain both costs.
        workerCostTotal: status === "rest" ? (options.task.taskId === "1" ? 2 : 4) : 3,
      };
    },
    onProgress: (update) => replacementUpdates.push(update),
  });

  assert.equal(replacementRun.status, "done");
  assert.deepEqual(replacementCalls, [
    { title: "Build API", status: "rest", attempt: 1 },
    { title: "Build API", status: "graphql", attempt: 1 },
    { title: "Document API", status: "rest", attempt: 1 },
  ]);
  assert.equal(replacementRun.completedTasks, 2);
  assert.equal(replacementRun.attemptedTasks, 3);
  assert.equal(replacementRun.attempts[0]?.obsolete, true);
  assert.equal(replacementRun.attempts[1]?.obsolete, false);
  assert.deepEqual(
    replacementRun.outcomes.map((outcome) => outcome.workerCostTotal),
    [2, 3, 4],
  );
  assert.equal(replacementRun.workerCostTotal, 9);
  assert.equal(replacementUpdates.filter((update) => update.phase === "task_obsolete").length, 1);
  assert.equal(
    replacementUpdates.filter((update) => update.phase === "task_done" && update.title === "Build API").length,
    1,
  );
  const replacementTasks = parseTasks(await readFile(replacementRun.todoPath, "utf8"));
  assert.equal(replacementTasks[0]?.section.includes("GraphQL"), true);
  assert.equal(replacementTasks[0]?.done, true);
  const replacementResults = await readFile(replacementRun.taskResultPath, "utf8");
  assert.match(replacementResults, /Plan disposition: obsolete/);
  assert.equal((replacementResults.match(/## TODO 1 — Build API \(attempt 1\)/g) ?? []).length, 2);

  // Guidance and worker completion can cross at the task boundary. The queue is
  // drained before settlement, and the store serializes revision + completion,
  // leaving one completion for the unchanged task and one pending inserted task.
  const boundaryQueue = new SerializedSteeringQueue({ queueId: "completion-boundary" });
  const boundaryCalls: string[] = [];
  let boundaryQueued = false;
  const boundaryUpdates: CoordinatorProgressUpdate[] = [];
  const boundaryRun = await runCoordinator({
    inputText: todo([{ title: "Boundary task", stableId: "boundary" }]),
    commit: false,
    cwd: root,
    runId: "completion-boundary",
    steeringQueue: boundaryQueue,
    todoPlanner: async (options) => {
      assert.equal(options.planRevision?.activeTask?.title, "Boundary task");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return todo([
        { title: "Boundary task", stableId: "boundary" },
        { title: "Boundary follow-up", stableId: "boundary-follow-up" },
      ]);
    },
    workerRunner: async (options) => {
      boundaryCalls.push(options.task.title);
      if (!boundaryQueued) {
        boundaryQueued = true;
        boundaryQueue.enqueue("Add a follow-up after this task.", "interactive");
      }
      return outcomeFor(options);
    },
    onProgress: (update) => boundaryUpdates.push(update),
  });

  assert.equal(boundaryRun.status, "done");
  assert.deepEqual(boundaryCalls, ["Boundary task", "Boundary follow-up"]);
  assert.equal(boundaryUpdates.filter((update) => update.phase === "task_done").length, 2);
  assert.equal(boundaryUpdates.filter((update) => update.phase === "task_obsolete").length, 0);
  assert.deepEqual(
    parseTasks(await readFile(boundaryRun.todoPath, "utf8")).map((task) => [task.title, task.done]),
    [
      ["Boundary task", true],
      ["Boundary follow-up", true],
    ],
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
