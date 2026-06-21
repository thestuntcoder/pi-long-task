import assert from "node:assert/strict";

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import { visibleWidth } from "@earendil-works/pi-tui";

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

const progressWithSidebar = renderLongTaskToolResult(
  {
    content: [{ type: "text", text: "Running TODO 2 — Add Sidebar Shell..." }],
    details: {
      phase: "task_start",
      message: "Running TODO 2 — Add Sidebar Shell...",
      currentTask: { taskId: "2", title: "Add Sidebar Shell", status: "in_progress" },
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
            title: "Add Sidebar Shell",
            status: "current",
            position: "current",
            done: false,
            statusItems: [],
            attempts: 0,
          },
          {
            taskId: "3",
            title: "Timeline",
            status: "pending",
            position: "future",
            done: false,
            statusItems: [],
            attempts: 0,
          },
        ],
        summary: {
          totalTasks: 3,
          completedTasks: 1,
          failedTasks: 0,
          blockedTasks: 0,
          pendingTasks: 1,
          currentTasks: 1,
          attemptedTasks: 1,
          completionRatio: 1 / 3,
          completedPercent: 33,
        },
        currentTaskId: "2",
        currentIndex: 1,
        currentTask: {
          taskId: "2",
          title: "Add Sidebar Shell",
          status: "current",
          position: "current",
          done: false,
          statusItems: [],
          attempts: 0,
        },
      },
    },
  } satisfies AgentToolResult<unknown>,
  { expanded: false, isPartial: true } satisfies ToolRenderResultOptions,
  theme,
);
const sidebarLines = progressWithSidebar.render(100);
const sidebarText = sidebarLines.join("\n");
assert.match(sidebarText, /TODO 2 .* Add Sidebar Shell/);
assert.match(sidebarText, /Long Task/);
assert.match(sidebarText, /Task sidebar/);
assert.match(sidebarText, /Progress \[###-------\] 1\/3 33%/);
assert.match(sidebarText, /Focus: TODO 2/);
assert.match(sidebarText, /✓ \[completed\] TODO 1 .* Audit/);
assert.match(sidebarText, /▶ \[current\] TODO 2 .* Add Side/);
assert.match(sidebarText, /○ \[pending\] TODO 3 .* Timeline/);
assert.ok(sidebarLines.every((line) => visibleWidth(line) <= 100));

for (const currentIndex of [0, 1, 2]) {
  const timeline = renderSidebarTimelineForCurrentIndex(currentIndex);
  assert.match(timeline, new RegExp(`Focus: TODO ${currentIndex + 1}`));
  assert.match(timeline, /Progress /);
  assert.match(timeline, /\[current\]/);
  const timelineSection = timeline.slice(timeline.indexOf("Timeline"));
  assert.ok(timelineSection.includes("TODO 1"));
  assert.ok(timelineSection.includes("TODO 2"));
  assert.ok(timelineSection.includes("TODO 3"));
  assert.ok(timelineSection.indexOf("TODO 1") < timelineSection.indexOf("TODO 2"));
  assert.ok(timelineSection.indexOf("TODO 2") < timelineSection.indexOf("TODO 3"));
}

function renderSidebarTimelineForCurrentIndex(currentIndex: number): string {
  const tasks = ["Plan", "Build", "Verify"].map((title, index) => ({
    taskId: String(index + 1),
    title,
    status: index < currentIndex ? "completed" : index === currentIndex ? "current" : "pending",
    position: index < currentIndex ? "past" : index === currentIndex ? "current" : "future",
    done: index < currentIndex,
    statusItems: [],
    attempts: index < currentIndex ? 1 : 0,
  }));
  const component = renderLongTaskToolResult(
    {
      content: [{ type: "text", text: `Running TODO ${currentIndex + 1}...` }],
      details: {
        phase: "task_start",
        message: `Running TODO ${currentIndex + 1}...`,
        taskProgress: {
          tasks,
          summary: {
            totalTasks: 3,
            completedTasks: currentIndex,
            failedTasks: 0,
            blockedTasks: 0,
            pendingTasks: 2 - currentIndex,
            currentTasks: 1,
            attemptedTasks: currentIndex,
            completionRatio: currentIndex / 3,
            completedPercent: Math.round((currentIndex / 3) * 100),
          },
          currentTaskId: String(currentIndex + 1),
          currentIndex,
          currentTask: tasks[currentIndex],
        },
      },
    } satisfies AgentToolResult<unknown>,
    { expanded: false, isPartial: true } satisfies ToolRenderResultOptions,
    theme,
  );

  return component.render(100).join("\n");
}
