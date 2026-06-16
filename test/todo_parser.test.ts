import assert from "node:assert/strict";

import {
  incompleteTasks,
  markTaskDone,
  parseTasks,
  todoGlobalInstructions,
  TodoParseError,
} from "../src/todo_parser.ts";

const markdown = `# Pi Long Task TODO

Global guardrail line.

## Progress

- [ ] TODO 1 — First task
- [x] TODO 2 - Second task
- [ ] TODO 10 — Tenth task

---

## TODO 1 — First task

**Status:**
- [ ] Define behavior
- [X] Keep existing checks

Notes stop the status block.
- [ ] Not part of status

## TODO 2 - Second task

**Status:**
- [ ] Progress overrides this unchecked status

## TODO 10 — Tenth task

**Status:**
- [x] Already done internally
`;

const tasks = parseTasks(markdown);
assert.equal(tasks.length, 3);
assert.deepEqual(
  tasks.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    done: task.done,
    progressDone: task.progressDone,
    statusCheckboxes: task.statusCheckboxes,
    statusItems: task.statusItems,
  })),
  [
    {
      taskId: "1",
      title: "First task",
      done: false,
      progressDone: false,
      statusCheckboxes: [false, true],
      statusItems: [
        { text: "Define behavior", done: false },
        { text: "Keep existing checks", done: true },
      ],
    },
    {
      taskId: "2",
      title: "Second task",
      done: true,
      progressDone: true,
      statusCheckboxes: [false],
      statusItems: [{ text: "Progress overrides this unchecked status", done: false }],
    },
    {
      taskId: "10",
      title: "Tenth task",
      done: false,
      progressDone: false,
      statusCheckboxes: [true],
      statusItems: [{ text: "Already done internally", done: true }],
    },
  ],
);
assert.equal(tasks[0].startLine, 13);
assert.ok(tasks[0].section.startsWith("## TODO 1 — First task\n"));
assert.deepEqual(
  incompleteTasks(markdown).map((task) => task.taskId),
  ["1", "10"],
);

const expectedMarked = `# Pi Long Task TODO

Global guardrail line.

## Progress

- [x] TODO 1 — First task
- [x] TODO 2 - Second task
- [ ] TODO 10 — Tenth task

---

## TODO 1 — First task

**Status:**
- [x] Define behavior
- [X] Keep existing checks

Notes stop the status block.
- [ ] Not part of status

## TODO 2 - Second task

**Status:**
- [ ] Progress overrides this unchecked status

## TODO 10 — Tenth task

**Status:**
- [x] Already done internally
`;
assert.equal(markTaskDone(markdown, "1"), expectedMarked);
assert.deepEqual(
  parseTasks(markTaskDone(markdown, "1")).map((task) => [task.taskId, task.done]),
  [
    ["1", true],
    ["2", true],
    ["10", false],
  ],
);

const statusOnly = `## TODO 3 — Status only

**Status:**
- [x] Step one
- [X] Step two
`;
assert.equal(parseTasks(statusOnly)[0].done, true);
assert.equal(todoGlobalInstructions(markdown), "# Pi Long Task TODO\n\nGlobal guardrail line.");
assert.equal(todoGlobalInstructions("Intro\n## TODO 1 — Direct task\nbody"), "Intro");
assert.equal(todoGlobalInstructions("abcdef", 3), "abc\n\n[truncated by Pi Long Task]");
assert.throws(() => parseTasks("# no tasks\n"), TodoParseError);
