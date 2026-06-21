import assert from "node:assert/strict";

import { buildTaskProgressModel } from "../src/task_progress.ts";
import { markTaskDone, parseTasks } from "../src/todo_parser.ts";

const markdown = `# Pi Long Task TODO

## Progress

- [ ] TODO 1 — Prepare state
- [ ] TODO 2 — Run current work
- [ ] TODO 3 — Render future work

## TODO 1 — Prepare state

**Status:**
- [ ] Add types

## TODO 2 — Run current work

**Status:**
- [x] Find integration point
- [ ] Build model

## TODO 3 — Render future work

**Status:**
- [ ] Add UI later
`;

const planned = buildTaskProgressModel({ tasks: parseTasks(markdown) });
assert.deepEqual(
  planned.tasks.map((task) => [task.taskId, task.status, task.position]),
  [
    ["1", "pending", "future"],
    ["2", "pending", "future"],
    ["3", "pending", "future"],
  ],
);
assert.deepEqual(planned.summary, {
  totalTasks: 3,
  completedTasks: 0,
  failedTasks: 0,
  blockedTasks: 0,
  pendingTasks: 3,
  currentTasks: 0,
  attemptedTasks: 0,
  completionRatio: 0,
  completedPercent: 0,
});
assert.equal(planned.currentTask, undefined);
assert.equal(planned.nextTaskId, "1");

const firstDone = markTaskDone(markdown, "1");
const current = buildTaskProgressModel({
  tasks: parseTasks(firstDone),
  attempts: [{ taskId: "1", attempt: 1, reportedStatus: "done", done: true }],
  currentTaskId: "2",
});
assert.deepEqual(
  current.tasks.map((task) => [task.taskId, task.status, task.position, task.attempts]),
  [
    ["1", "completed", "past", 1],
    ["2", "current", "current", 0],
    ["3", "pending", "future", 0],
  ],
);
assert.equal(current.currentTaskId, "2");
assert.equal(current.currentIndex, 1);
assert.equal(current.nextTaskId, "3");
assert.equal(current.summary.completedTasks, 1);
assert.equal(current.summary.currentTasks, 1);
assert.equal(current.summary.completionRatio, 1 / 3);
assert.equal(current.summary.completedPercent, 33);

const completedCurrent = buildTaskProgressModel({
  tasks: parseTasks(firstDone),
  attempts: [
    { taskId: "1", attempt: 1, reportedStatus: "done", done: true },
    { taskId: "2", attempt: 1, reportedStatus: "done", done: true },
  ],
  currentTaskId: "2",
  currentTaskStatus: "completed",
});
assert.deepEqual(
  completedCurrent.tasks.map((task) => [task.taskId, task.status, task.position]),
  [
    ["1", "completed", "past"],
    ["2", "completed", "current"],
    ["3", "pending", "future"],
  ],
);
assert.equal(completedCurrent.summary.completedTasks, 2);

const failedCurrent = buildTaskProgressModel({
  tasks: parseTasks(firstDone),
  attempts: [
    { taskId: "1", attempt: 1, reportedStatus: "done", done: true },
    { taskId: "2", attempt: 1, reportedStatus: "partial", done: false },
  ],
  currentTaskId: "2",
  currentTaskStatus: "failed",
});
assert.deepEqual(
  failedCurrent.tasks.map((task) => [task.taskId, task.status, task.position, task.lastReportedStatus]),
  [
    ["1", "completed", "past", "done"],
    ["2", "failed", "current", "partial"],
    ["3", "pending", "future", undefined],
  ],
);
assert.equal(failedCurrent.summary.failedTasks, 1);
assert.equal(failedCurrent.summary.pendingTasks, 1);
assert.equal(failedCurrent.summary.attemptedTasks, 2);

const blockedNoActive = buildTaskProgressModel({
  tasks: parseTasks(firstDone),
  attempts: [
    { taskId: "1", attempt: 1, reportedStatus: "done", done: true },
    { taskId: "2", attempt: 1, reportedStatus: "blocked", done: false },
  ],
});
assert.deepEqual(
  blockedNoActive.tasks.map((task) => [task.taskId, task.status, task.position]),
  [
    ["1", "completed", "past"],
    ["2", "blocked", "past"],
    ["3", "pending", "future"],
  ],
);
assert.equal(blockedNoActive.summary.blockedTasks, 1);
assert.equal(blockedNoActive.currentTask, undefined);
assert.equal(blockedNoActive.nextTaskId, "3");
