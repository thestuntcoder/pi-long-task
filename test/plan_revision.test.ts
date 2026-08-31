import assert from "node:assert/strict";

import { PlanRevisionError, reconcilePlanRevision } from "../src/plan_revision.ts";
import { parseTasks } from "../src/todo_parser.ts";

interface Spec {
  title: string;
  step?: string;
  done?: boolean;
  stableId?: string;
}

function plan(specs: readonly Spec[]) {
  const progress = specs
    .map((spec, index) => `- [${spec.done ? "x" : " "}] TODO ${index + 1} — ${spec.title}`)
    .join("\n");
  const sections = specs
    .map(
      (spec, index) =>
        `## TODO ${index + 1} — ${spec.title}\n${
          spec.stableId ? `\n<!-- pi-long-task-id: ${spec.stableId} -->\n` : ""
        }\n**Goal:** Complete ${spec.title}.\n\n**Status:**\n- [${spec.done ? "x" : " "}] ${
          spec.step ?? `Implement ${spec.title}`
        }\n\n**Verify:**\n- Run focused tests.\n\n**Done when:** Complete.`,
    )
    .join("\n\n");
  return parseTasks(`# Pi Long Task TODO\n\n## Progress\n\n${progress}\n\n---\n\n${sections}\n`);
}

function assertCompletedFoundation(result: ReturnType<typeof reconcilePlanRevision>): void {
  const foundation = result.activeTasks.find((item) => item.task.title === "Foundation");
  assert.ok(foundation, "unchanged completed Foundation must remain in the active plan");
  assert.equal(foundation.state, "completed");
  assert.equal(foundation.task.done, true);
  assert.equal(foundation.preserveOutputs, true);
  assert.match(foundation.task.section, new RegExp(`pi-long-task-id: ${foundation.identity}`));
}

const baseline = plan([
  { title: "Foundation", done: true, stableId: "foundation" },
  { title: "Build API" },
  { title: "Write docs" },
]);

// Unchanged content matches despite revised numbering and unchecked planner state.
const unchanged = reconcilePlanRevision(
  baseline,
  plan([{ title: "Foundation", stableId: "foundation" }, { title: "Build API" }, { title: "Write docs" }]),
);
assertCompletedFoundation(unchanged);
assert.deepEqual(
  unchanged.activeTasks.map((item) => [item.task.title, item.revisionKind, item.state]),
  [
    ["Foundation", "unchanged", "completed"],
    ["Build API", "unchanged", "pending"],
    ["Write docs", "unchanged", "pending"],
  ],
);

// A pending task can be modified in place; prior attempts/state do not claim the new requirement.
const modified = reconcilePlanRevision(
  baseline,
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "Build API", step: "Implement API with pagination" },
    { title: "Write docs" },
  ]),
  { previousStates: { "2": "failed" } },
);
assertCompletedFoundation(modified);
assert.deepEqual(
  modified.activeTasks.map((item) => [item.task.title, item.revisionKind, item.state]),
  [
    ["Foundation", "unchanged", "completed"],
    ["Build API", "modified", "pending"],
    ["Write docs", "unchanged", "pending"],
  ],
);
assert.equal(modified.matches.find((match) => match.previousTaskId === "2")?.kind, "unique_title");

// Insertions shift indexes but do not count as reordering matched work.
const inserted = reconcilePlanRevision(
  baseline,
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "Add schema" },
    { title: "Build API" },
    { title: "Write docs" },
  ]),
);
assertCompletedFoundation(inserted);
assert.equal(inserted.activeTasks.find((item) => item.task.title === "Add schema")?.revisionKind, "inserted");
assert.equal(
  inserted.matches.every((match) => !match.reordered),
  true,
);

// Removed pending work leaves scheduling but remains in retired audit state.
const removed = reconcilePlanRevision(
  baseline,
  plan([{ title: "Foundation", stableId: "foundation" }, { title: "Write docs" }]),
);
assertCompletedFoundation(removed);
assert.equal(
  removed.activeTasks.some((item) => item.task.title === "Build API"),
  false,
);
assert.deepEqual(
  removed.retiredTasks.map((item) => [item.task.title, item.reason, item.preserveOutputs]),
  [["Build API", "removed", false]],
);

const removedCompleted = reconcilePlanRevision(
  plan([
    { title: "Foundation", done: true, stableId: "foundation" },
    { title: "Obsolete migration", done: true, stableId: "migration" },
    { title: "Write docs" },
  ]),
  plan([{ title: "Foundation", stableId: "foundation" }, { title: "Write docs" }]),
);
assertCompletedFoundation(removedCompleted);
assert.deepEqual(
  removedCompleted.retiredTasks.map((item) => [item.task.title, item.state, item.reason, item.preserveOutputs]),
  [["Obsolete migration", "completed", "removed", true]],
);

// Relative inversions are reorders; completion and outputs still follow the matched identity.
const reordered = reconcilePlanRevision(
  baseline,
  plan([{ title: "Write docs" }, { title: "Foundation", stableId: "foundation" }, { title: "Build API" }]),
);
assertCompletedFoundation(reordered);
assert.deepEqual(
  reordered.matches.map((match) => [match.previousTaskId, match.revisedTaskId, match.reordered]),
  [
    ["3", "1", true],
    ["1", "2", true],
    ["2", "3", true],
  ],
);

// Changing completed work preserves its historical completion and schedules a follow-up.
const completedChangedBaseline = plan([
  { title: "Foundation", done: true, stableId: "foundation" },
  { title: "Configure auth", done: true, stableId: "auth" },
]);
const completedChanged = reconcilePlanRevision(
  completedChangedBaseline,
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "Configure auth", step: "Switch auth to passkeys", stableId: "auth" },
  ]),
  { revisionId: "revision-2" },
);
assertCompletedFoundation(completedChanged);
const authFollowUp = completedChanged.activeTasks.find((item) => item.task.title === "Configure auth");
assert.equal(authFollowUp?.revisionKind, "follow_up");
assert.equal(authFollowUp?.state, "pending");
assert.equal(authFollowUp?.followUpForIdentity, "auth");
assert.equal(authFollowUp?.task.stableId, authFollowUp?.identity);
assert.deepEqual(
  completedChanged.retiredTasks.map((item) => [item.task.title, item.state, item.reason, item.preserveOutputs]),
  [["Configure auth", "completed", "superseded", true]],
);

// Explicit invalidation follows the same history-preserving rule even when text is unchanged.
const invalidated = reconcilePlanRevision(
  completedChangedBaseline,
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "Configure auth", stableId: "auth" },
  ]),
  { invalidatedTaskIds: ["2"], revisionId: "revision-3" },
);
assertCompletedFoundation(invalidated);
assert.equal(invalidated.activeTasks[1].revisionKind, "follow_up");
assert.equal(invalidated.activeTasks[1].state, "pending");
assert.equal(invalidated.retiredTasks[0].reason, "invalidated");
assert.equal(invalidated.retiredTasks[0].preserveOutputs, true);

// A modified running task is replaced and its eventual worker result is stale.
const running = reconcilePlanRevision(
  baseline,
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "Build API", step: "Use a new API protocol" },
    { title: "Write docs" },
  ]),
  { runningTaskId: "2" },
);
assertCompletedFoundation(running);
assert.equal(running.activeTasks[1].state, "pending");
assert.equal(running.activeTasks[1].revisionKind, "modified");
assert.deepEqual(running.staleRunningTaskIds, ["2"]);
assert.deepEqual(
  running.retiredTasks.map((item) => [item.task.title, item.state, item.reason]),
  [["Build API", "running", "superseded"]],
);

// Stable IDs permit deterministic matching across both title and content changes.
const stableRenamed = reconcilePlanRevision(
  plan([
    { title: "Foundation", done: true, stableId: "foundation" },
    { title: "Old API name", stableId: "api" },
  ]),
  plan([
    { title: "Foundation", stableId: "foundation" },
    { title: "New API name", stableId: "api" },
  ]),
);
assertCompletedFoundation(stableRenamed);
assert.equal(stableRenamed.matches[1].kind, "stable_id");
assert.equal(stableRenamed.activeTasks[1].revisionKind, "modified");

assert.throws(
  () =>
    reconcilePlanRevision(
      plan([{ title: "One", stableId: "duplicate" }]),
      plan([
        { title: "One", stableId: "duplicate" },
        { title: "Two", stableId: "duplicate" },
      ]),
    ),
  PlanRevisionError,
);
assert.throws(() => reconcilePlanRevision(baseline, baseline, { invalidatedTaskIds: ["99"] }), PlanRevisionError);
