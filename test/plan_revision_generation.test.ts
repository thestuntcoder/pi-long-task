import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinator, type WorkerRunner } from "../src/coordinator.ts";
import {
  generatePlanRevision,
  PlanRevisionGenerationError,
  type PlanRevisionPlannerInput,
} from "../src/plan_revision_generation.ts";
import { SerializedSteeringQueue } from "../src/steering.ts";
import { validateTodoMarkdown } from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";

interface TaskSpec {
  title: string;
  stableId?: string;
  status?: string;
  done?: boolean;
}

function todo(specs: readonly TaskSpec[]): string {
  const progress = specs
    .map((spec, index) => `- [${spec.done ? "x" : " "}] TODO ${index + 1} — ${spec.title}`)
    .join("\n");
  const sections = specs
    .map(
      (spec, index) =>
        `## TODO ${index + 1} — ${spec.title}\n${
          spec.stableId ? `\n<!-- pi-long-task-id: ${spec.stableId} -->\n` : ""
        }\n**Goal:** Complete ${spec.title}.\n\n**Status:**\n- [${spec.done ? "x" : " "}] ${
          spec.status ?? `Implement ${spec.title}`
        }\n\n**Verify:**\n- Run focused tests.\n\n**Done when:** The task is complete.`,
    )
    .join("\n\n");
  return `# Pi Long Task TODO\n\nGlobal instructions:\n- Keep existing behavior.\n\n## Progress\n\n${progress}\n\n---\n\n${sections}\n`;
}

const currentPlan = todo([
  { title: "Foundation", stableId: "foundation", done: true },
  { title: "Build API", stableId: "api" },
  { title: "Write docs", stableId: "docs" },
]);
const proposal = todo([
  // Planner completion is intentionally unchecked. Reconciliation owns it.
  { title: "Foundation", stableId: "foundation" },
  { title: "Add accessibility audit", stableId: "accessibility" },
  { title: "Write docs", stableId: "docs" },
  { title: "Build API", stableId: "api", status: "Implement API with pagination" },
  { title: "Add analytics dashboard" },
]);

let plannerInput: PlanRevisionPlannerInput | undefined;
const revised = await generatePlanRevision({
  currentTodoMarkdown: currentPlan,
  guidance:
    "Add accessibility before docs, move docs before the API, add pagination to the API, and append analytics work.",
  revisionId: "steering:1",
  taskStates: { "1": "completed", "2": "failed", "3": "pending" },
  activeTask: { taskId: "3", title: "Write docs", attempt: 2, activity: "Editing README" },
  relevantResults: [
    {
      taskId: "1",
      status: "done",
      summary: "Foundation implemented and tested.",
      outputReferences: ["TASK_RESULT.md#todo-1", "commit:abc123"],
    },
  ],
  planner: async (input) => {
    plannerInput = input;
    return proposal;
  },
});

assert.ok(plannerInput);
assert.equal(plannerInput.request.currentTodoMarkdown, currentPlan);
assert.equal(plannerInput.request.guidance.includes("pagination"), true);
assert.equal(plannerInput.request.taskStates["1"], "completed");
assert.equal(plannerInput.request.taskStates["2"], "failed");
assert.equal(plannerInput.request.taskStates["3"], "running");
assert.equal(plannerInput.request.relevantResults[0]?.summary, "Foundation implemented and tested.");
assert.equal(plannerInput.request.activeTask?.activity, "Editing README");
assert.match(plannerInput.prompt, /Return one complete, valid revised plan/);
assert.match(plannerInput.prompt, /Current complete TODO plan:/);
assert.match(plannerInput.prompt, /Foundation implemented and tested/);
assert.match(plannerInput.prompt, /Editing README/);
assert.match(plannerInput.prompt, /append analytics work/);

validateTodoMarkdown(revised.todoMarkdown);
const revisedTasks = parseTasks(revised.todoMarkdown);
assert.deepEqual(
  revisedTasks.map((task) => [task.taskId, task.title, task.done]),
  [
    ["1", "Foundation", true],
    ["2", "Add accessibility audit", false],
    ["3", "Write docs", false],
    ["4", "Build API", false],
    ["5", "Add analytics dashboard", false],
  ],
);
assert.deepEqual(
  revised.reconciliation.activeTasks.map((item) => [item.task.title, item.state, item.revisionKind]),
  [
    ["Foundation", "completed", "unchanged"],
    ["Add accessibility audit", "pending", "inserted"],
    ["Write docs", "running", "unchanged"],
    ["Build API", "pending", "modified"],
    ["Add analytics dashboard", "pending", "inserted"],
  ],
);
assert.equal(revised.reconciliation.activeTasks[0]?.preserveOutputs, true);
assert.equal(revised.reconciliation.activeTasks[3]?.preserveOutputs, false);
assert.equal(revised.reconciliation.matches.find((match) => match.previousTaskId === "3")?.reordered, true);
assert.deepEqual(revised.preservedResults, [
  {
    previousTaskId: "1",
    identity: "foundation",
    retainedAs: "active",
    result: {
      taskId: "1",
      status: "done",
      summary: "Foundation implemented and tested.",
      outputReferences: ["TASK_RESULT.md#todo-1", "commit:abc123"],
    },
  },
]);
assert.match(revised.todoMarkdown, /<!-- pi-long-task-id: foundation -->/);
assert.match(revised.todoMarkdown, /<!-- pi-long-task-id: accessibility -->/);
assert.match(revised.todoMarkdown, /Keep existing behavior/);

// Guidance that changes completed work creates pending follow-up work while
// retaining the completed result as historical output rather than erasing it.
const completedCorrection = await generatePlanRevision({
  currentTodoMarkdown: currentPlan,
  guidance: "Correct the completed foundation to use the new storage engine.",
  revisionId: "steering:2",
  relevantResults: [
    {
      taskId: "1",
      status: "done",
      summary: "Original foundation remains a valid migration baseline.",
      outputReferences: ["artifact:foundation-v1"],
    },
  ],
  planner: async () =>
    todo([
      {
        title: "Foundation",
        stableId: "foundation",
        status: "Migrate the foundation to the new storage engine",
      },
      { title: "Build API", stableId: "api" },
      { title: "Write docs", stableId: "docs" },
    ]),
});
validateTodoMarkdown(completedCorrection.todoMarkdown);
const foundationFollowUp = completedCorrection.reconciliation.activeTasks[0];
assert.equal(foundationFollowUp?.revisionKind, "follow_up");
assert.equal(foundationFollowUp?.state, "pending");
assert.equal(foundationFollowUp?.followUpForIdentity, "foundation");
assert.notEqual(foundationFollowUp?.identity, "foundation");
assert.deepEqual(
  completedCorrection.reconciliation.retiredTasks.map((item) => [
    item.identity,
    item.state,
    item.reason,
    item.preserveOutputs,
  ]),
  [["foundation", "completed", "superseded", true]],
);
assert.equal(completedCorrection.preservedResults[0]?.retainedAs, "history");
assert.equal(completedCorrection.preservedResults[0]?.identity, "foundation");
assert.equal(parseTasks(completedCorrection.todoMarkdown)[0]?.done, false);

// Explicit invalidation cannot silently remove completed history, even if the
// planner omits the task. Reconciliation appends replacement work.
const invalidatedRemoval = await generatePlanRevision({
  currentTodoMarkdown: currentPlan,
  guidance: "The foundation result is invalid; schedule a corrective pass.",
  revisionId: "steering:3",
  invalidatedTaskIds: ["1"],
  relevantResults: [{ taskId: "1", status: "done", summary: "Retain for audit only." }],
  planner: async () =>
    todo([
      { title: "Build API", stableId: "api" },
      { title: "Write docs", stableId: "docs" },
    ]),
});
validateTodoMarkdown(invalidatedRemoval.todoMarkdown);
assert.equal(invalidatedRemoval.reconciliation.retiredTasks[0]?.reason, "invalidated");
const appendedCorrection = invalidatedRemoval.reconciliation.activeTasks.at(-1);
assert.equal(appendedCorrection?.followUpForIdentity, "foundation");
assert.equal(appendedCorrection?.state, "pending");
assert.equal(invalidatedRemoval.preservedResults[0]?.retainedAs, "history");

// Malformed output is rejected before replacement. The error carries the
// still-usable prior plan for a serialized queue retry/recovery path.
let activePlan = currentPlan;
await assert.rejects(
  async () => {
    const accepted = await generatePlanRevision({
      currentTodoMarkdown: activePlan,
      guidance: "Insert a security review.",
      revisionId: "steering:malformed",
      planner: async () => "This is not TODO markdown.",
    });
    activePlan = accepted.todoMarkdown;
  },
  (error: unknown) => {
    assert.ok(error instanceof PlanRevisionGenerationError);
    assert.equal(error.recoverable, true);
    assert.equal(error.priorTodoMarkdown, currentPlan);
    assert.match(error.message, /was not accepted/i);
    return true;
  },
);
assert.equal(activePlan, currentPlan);
validateTodoMarkdown(activePlan);

// A structurally valid proposal that fails reconciliation validation is also
// recoverable and cannot replace the active plan.
await assert.rejects(
  () =>
    generatePlanRevision({
      currentTodoMarkdown: currentPlan,
      guidance: "Duplicate Foundation (invalid planner behavior).",
      revisionId: "steering:duplicate-id",
      planner: async () =>
        todo([
          { title: "Foundation", stableId: "foundation" },
          { title: "Foundation duplicate", stableId: "foundation" },
        ]),
    }),
  PlanRevisionGenerationError,
);
validateTodoMarkdown(currentPlan);

// The coordinator consumes the serialized queue, persists accepted revisions,
// and continues scheduling newly inserted work in the same run.
const integrationRoot = await mkdtemp(path.join(os.tmpdir(), "pi-plan-revision-generation-"));
try {
  let releaseWorker: (() => void) | undefined;
  let reportWorkerStarted: (() => void) | undefined;
  const workerStarted = new Promise<void>((resolve) => {
    reportWorkerStarted = resolve;
  });
  const workerRelease = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const workerRunner: WorkerRunner = async (options) => {
    reportWorkerStarted?.();
    await workerRelease;
    const timestamp = new Date("2026-08-31T01:00:00.000Z").toISOString();
    return {
      task: options.task,
      attempt: options.attempt,
      startedAt: timestamp,
      endedAt: timestamp,
      reportedStatus: "done",
      done: true,
      assistantText:
        "TASK_RESULT:\nstatus: done\nsummary: completed\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none",
      contextObservations: [],
      compactionEvents: [],
      events: [],
      workerCostTotal: 0,
      shutdownRequested: false,
      timedOut: false,
      aborted: false,
    };
  };
  const queue = new SerializedSteeringQueue({ queueId: "coordinator-revision" });
  let acceptedRevision: Awaited<ReturnType<typeof generatePlanRevision>> | undefined;
  let structuredPlannerContextSeen = false;
  const execution = runCoordinator({
    cwd: integrationRoot,
    runId: "accepted-revision",
    inputText: currentPlan,
    commit: false,
    steeringQueue: queue,
    workerRunner,
    todoPlanner: async (options) => {
      structuredPlannerContextSeen = Boolean(options.planRevision && options.plannerPrompt);
      assert.match(options.planRevision?.guidance ?? "", /security review/i);
      return todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Security review", stableId: "security" },
        { title: "Build API", stableId: "api" },
        { title: "Write docs", stableId: "docs" },
      ]);
    },
    onPlanRevisionAccepted: (revision) => {
      acceptedRevision = revision;
    },
  });
  await workerStarted;
  queue.enqueue("Insert a security review before the API.", "interactive");
  await queue.waitForIdle();
  assert.equal(structuredPlannerContextSeen, true);
  assert.ok(acceptedRevision);
  validateTodoMarkdown(acceptedRevision.todoMarkdown);
  assert.deepEqual(
    parseTasks(acceptedRevision.todoMarkdown).map((task) => task.title),
    ["Foundation", "Security review", "Build API", "Write docs"],
  );
  releaseWorker?.();
  const acceptedRun = await execution;
  const persistedAccepted = await readFile(acceptedRun.todoPath, "utf8");
  assert.deepEqual(
    parseTasks(persistedAccepted).map((task) => [task.title, task.done, Boolean(task.stableId)]),
    [
      ["Foundation", true, true],
      ["Security review", true, true],
      ["Build API", true, true],
      ["Write docs", true, true],
    ],
  );
  assert.equal(acceptedRun.taskProgress.summary.completedTasks, 4);
  assert.equal(acceptedRun.taskProgress.summary.totalTasks, 4);

  let releaseMalformedWorker: (() => void) | undefined;
  let reportMalformedWorkerStarted: (() => void) | undefined;
  const malformedWorkerStarted = new Promise<void>((resolve) => {
    reportMalformedWorkerStarted = resolve;
  });
  const malformedWorkerRelease = new Promise<void>((resolve) => {
    releaseMalformedWorker = resolve;
  });
  const malformedQueue = new SerializedSteeringQueue({ queueId: "coordinator-malformed" });
  let malformedAccepted = false;
  const malformedExecution = runCoordinator({
    cwd: integrationRoot,
    runId: "malformed-revision",
    inputText: currentPlan,
    commit: false,
    steeringQueue: malformedQueue,
    workerRunner: async (options) => {
      reportMalformedWorkerStarted?.();
      await malformedWorkerRelease;
      return workerRunner(options);
    },
    todoPlanner: async () => "malformed planner output",
    onPlanRevisionAccepted: () => {
      malformedAccepted = true;
    },
  });
  await malformedWorkerStarted;
  malformedQueue.enqueue("Replace docs with malformed output.", "interactive");
  await malformedQueue.waitForIdle();
  assert.equal(malformedAccepted, false);
  assert.equal(malformedQueue.pendingMessages()[0]?.status, "failed");
  const persistedPrior = await readFile(
    path.join(integrationRoot, "tmp", "pi-long-task", "malformed-revision", "TODO.md"),
    "utf8",
  );
  assert.equal(persistedPrior, currentPlan);
  validateTodoMarkdown(persistedPrior);
  // Resolve both layers used by this test worker wrapper.
  releaseMalformedWorker?.();
  releaseWorker?.();
  await malformedExecution;
} finally {
  await rm(integrationRoot, { recursive: true, force: true });
}
