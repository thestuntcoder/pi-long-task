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
assert.equal(renderText(progress), "+ Build: TODO 1: worker tool bash started.");

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
    "+ Build: TODO 2 — Wire progress UI · worker bash",
    "  ⚙ worker bash · TODO 2: worker tool bash started.",
    "  ✓ done · Parse status checkboxes",
    "  + active · Render active subtask",
    "  ○ queued · Add coverage",
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

const callWithGoal = renderLongTaskToolCall(
  {
    commit: false,
    goal: "Ship the accessibility fixes.",
    inputText: "Update the product pages.",
  },
  theme,
);
assert.equal(
  renderText(callWithGoal),
  'pi_long_task commit:off goal:"Ship the accessibility fixes." "Update the product pages."',
);

const progressWithTaskProgress = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "Running TODO 2 — Wire Sidebar Rendering..." }],
    details: {
      phase: "task_start",
      message: "Running TODO 2 — Wire Sidebar Rendering...",
      currentTask: { taskId: "2", title: "Wire Sidebar Rendering", status: "in_progress" },
      taskProgress: {
        tasks: [
          {
            taskId: "1",
            title: "Audit",
            status: "completed",
            position: "past",
            done: true,
            statusItems: [],
            attempts: 1,
          },
          {
            taskId: "2",
            title: "Wire Sidebar Rendering",
            status: "current",
            position: "current",
            done: false,
            statusItems: [],
            attempts: 0,
          },
        ],
        summary: {
          totalTasks: 2,
          completedTasks: 1,
          failedTasks: 0,
          blockedTasks: 0,
          pendingTasks: 0,
          currentTasks: 1,
          attemptedTasks: 1,
          completionRatio: 1 / 2,
          completedPercent: 50,
        },
      },
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: false, isPartial: true } satisfies ToolRenderResultOptions,
  theme,
);
const taskProgressText = renderText(progressWithTaskProgress);
assert.match(taskProgressText, /\+ Build: TODO 2 .* Wire Sidebar Rendering/);
assert.match(taskProgressText, /✓ ▢ 1\/2 .* 50% .* 1 active/);
assert.doesNotMatch(taskProgressText, /Task sidebar/);
assert.doesNotMatch(taskProgressText, /Long Task/);
assert.doesNotMatch(taskProgressText, /Progress \[/);
