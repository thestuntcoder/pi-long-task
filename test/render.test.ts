import assert from "node:assert/strict";

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import { renderLongTaskToolCall, renderLongTaskToolResult } from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function renderText(component: { render(width: number): string[] }, width = 200): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

const collapsed = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "ignored when details are present" }],
    details: {
      runId: "run-1",
      status: "done",
      summary: "Pi Long Task completed 2/2 task(s).",
      totalTasks: 2,
      completedTasks: 2,
      failedTasks: 0,
      blockedTasks: 0,
      todoPath: "/tmp/repo/tmp/pi-long-task/run-1/TODO.md",
      resultPath: "/tmp/repo/tmp/pi-long-task/run-1/TASK_RESULT.md",
      commits: [{ taskId: "1", hash: "abc1234" }],
      remainingTasks: [],
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: false, isPartial: false } satisfies ToolRenderResultOptions,
  theme,
);
assert.equal(renderText(collapsed), "✓ Pi Long Task done — 2/2 tasks — 1 commit");

const expanded = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "ignored when details are present" }],
    details: {
      status: "failed",
      summary: "Pi Long Task failed: task failed",
      totalTasks: 2,
      completedTasks: 0,
      failedTasks: 1,
      blockedTasks: 0,
      todoPath: "/tmp/repo/tmp/pi-long-task/run-2/TODO.md",
      resultPath: "/tmp/repo/tmp/pi-long-task/run-2/TASK_RESULT.md",
      commits: [{ taskId: "1", error: "commit exploded" }],
      remainingTasks: [{ taskId: "1", title: "Fix failure", status: "failed" }],
      error: "task failed",
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: true, isPartial: false } satisfies ToolRenderResultOptions,
  theme,
);
const expandedText = renderText(expanded);
assert.match(expandedText, /✗ Pi Long Task failed — 0\/2 tasks — 1 failed — 2 remaining/);
assert.match(expandedText, /Result: \/tmp\/repo\/tmp\/pi-long-task\/run-2\/TASK_RESULT\.md/);
assert.match(expandedText, /- TODO 1: commit error: commit exploded/);
assert.match(expandedText, /- TODO 1 — Fix failure \(failed\)/);
assert.match(expandedText, /Error: task failed/);

const progress = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "TODO 1: worker tool bash started." }],
    details: {
      phase: "worker_tool",
      message: "TODO 1: worker tool bash started.",
      toolName: "bash",
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: false, isPartial: true } satisfies ToolRenderResultOptions,
  theme,
);
assert.equal(renderText(progress), "● worker bash TODO 1: worker tool bash started.");

const progressWithSubtasks = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "TODO 2: worker tool bash started." }],
    details: {
      phase: "worker_tool",
      message: "TODO 2: worker tool bash started.",
      toolName: "bash",
      currentTask: { taskId: "2", title: "Wire progress UI", status: "in_progress" },
      subtasks: [
        { text: "Parse status checkboxes", status: "done" },
        { text: "Render active subtask", status: "in_progress" },
        { text: "Add coverage", status: "empty" },
      ],
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: false, isPartial: true } satisfies ToolRenderResultOptions,
  theme,
);
assert.equal(
  renderText(progressWithSubtasks),
  [
    "● worker bash TODO 2 — Wire progress UI",
    "  TODO 2: worker tool bash started.",
    "  ● Parse status checkboxes",
    "  ● Render active subtask",
    "  ○ Add coverage",
  ].join("\n"),
);

const call = renderLongTaskToolCall(
  {
    commit: true,
    inputText: "Create a marker file and verify it with cat.",
  },
  theme,
);
assert.equal(renderText(call), 'pi_long_task commit:on "Create a marker file and verify it with cat."');
