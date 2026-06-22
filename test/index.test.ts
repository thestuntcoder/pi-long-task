import assert from "node:assert/strict";

import {
  addWorkerCostToAssistantMessage,
  createLongTaskSidebarController,
  createWorkerCostAccumulator,
} from "../src/index.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { CoordinatorProgressUpdate } from "../src/coordinator.ts";

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "parent response" }],
    api: "openai-chat-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037,
      },
    },
    stopReason: "stop",
    timestamp: 123,
  };
}

const original = assistantMessage();
const patched = addWorkerCostToAssistantMessage(original, 0.125);
assert.ok(patched);
assert.equal(patched.usage.cost.total, 0.162);
assert.deepEqual(
  {
    input: patched.usage.input,
    output: patched.usage.output,
    cacheRead: patched.usage.cacheRead,
    cacheWrite: patched.usage.cacheWrite,
    totalTokens: patched.usage.totalTokens,
  },
  {
    input: original.usage.input,
    output: original.usage.output,
    cacheRead: original.usage.cacheRead,
    cacheWrite: original.usage.cacheWrite,
    totalTokens: original.usage.totalTokens,
  },
);
assert.deepEqual(
  {
    input: patched.usage.cost.input,
    output: patched.usage.cost.output,
    cacheRead: patched.usage.cost.cacheRead,
    cacheWrite: patched.usage.cost.cacheWrite,
  },
  {
    input: original.usage.cost.input,
    output: original.usage.cost.output,
    cacheRead: original.usage.cost.cacheRead,
    cacheWrite: original.usage.cost.cacheWrite,
  },
);

const accumulator = createWorkerCostAccumulator();
assert.equal(accumulator.applyToAssistantMessage(assistantMessage()), undefined);
accumulator.add(0.05);
accumulator.add(Number.NaN);
accumulator.add(-1);
const first = accumulator.applyToAssistantMessage(assistantMessage());
assert.ok(first);
assert.equal(first.usage.cost.total, 0.087);
assert.equal(accumulator.applyToAssistantMessage(assistantMessage()), undefined);

const widgetCalls: Array<{ key: string; content: string[] | undefined; placement?: string }> = [];
let overlayComponent: Component | undefined;
let overlayClosed = false;
let overlayUnfocused = false;
let renderRequests = 0;
const sidebarTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const sidebar = createLongTaskSidebarController({
  hasUI: true,
  mode: "tui",
  ui: {
    setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
      widgetCalls.push({ key, content, placement: options?.placement });
    },
    custom<T>(
      factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
      options?: { onHandle?: (handle: OverlayHandle) => void; overlay?: boolean },
    ): Promise<T> {
      assert.equal(options?.overlay, true);
      return new Promise<T>((resolve) => {
        overlayComponent = factory(
          {
            requestRender: () => {
              renderRequests += 1;
            },
          } as unknown as TUI,
          sidebarTheme,
          {},
          (result) => {
            overlayClosed = true;
            resolve(result);
          },
        );
        options?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden: () => false,
          focus() {},
          unfocus() {
            overlayUnfocused = true;
          },
          isFocused: () => false,
        });
      });
    },
  },
} as never);

assert.ok(sidebar);
assert.equal(widgetCalls[0]?.key, "pi-long-task-sidebar");
assert.deepEqual(widgetCalls[0]?.content, ["Pi Long Task: preparing sidebar..."]);
assert.equal(widgetCalls[0]?.placement, "aboveEditor");
assert.ok(overlayUnfocused);

const sidebarUpdate = {
  message: "Running TODO 2 — Wire Sidebar Rendering...",
  phase: "task_start",
  runId: "run-1",
  todoPath: "/tmp/TODO.md",
  resultPath: "/tmp/TASK_RESULT.md",
  taskId: "2",
  title: "Wire Sidebar Rendering",
  attempt: 1,
  workerCostTotal: 0.0123,
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
        attempts: 1,
      },
      {
        taskId: "3",
        title: "Docs",
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
  },
  subtasks: [{ text: "Route onUpdate data", status: "in_progress" }],
} satisfies CoordinatorProgressUpdate;

sidebar.update(sidebarUpdate);
const runningWidget = widgetCalls.at(-1)?.content?.join("\n") ?? "";
assert.match(runningWidget, /Pi Long Task/);
assert.match(runningWidget, /▢ Running task .* Running TODO 2/);
assert.match(runningWidget, /active: ▢ TODO 2 .* Wire Sidebar Rendering/);
assert.match(runningWidget, /Spent: \$0\.01/);
assert.equal(renderRequests, 1);
const overlayText = overlayComponent?.render(80).join("\n") ?? "";
assert.match(overlayText, /Task timeline/);
assert.match(overlayText, /Current/);
assert.match(overlayText, /Tasks 1\/3 .* 33% complete .* ■▢·/);
assert.match(overlayText, /■ done .* ▢ active .* · queued/);
assert.match(overlayText, /▢ TODO 2 .* active/);
assert.match(overlayText, /› ▢ TODO 2/);
assert.match(overlayText, /Wire Sidebar Rendering/);
assert.match(overlayText, /\+ active .* Route onUpdate data/);

sidebar.update({
  ...sidebarUpdate,
  message: "TODO 2 done.",
  phase: "task_done",
  status: "done",
  taskProgress: {
    ...sidebarUpdate.taskProgress,
    summary: {
      ...sidebarUpdate.taskProgress.summary,
      completedTasks: 2,
      pendingTasks: 1,
      currentTasks: 0,
      completedPercent: 67,
      completionRatio: 2 / 3,
    },
  },
});
const doneWidget = widgetCalls.at(-1)?.content?.join("\n") ?? "";
assert.match(doneWidget, /done .* TODO 2 done/);
assert.match(doneWidget, /Tasks: 2\/3 .* 67% .* 1 queued/);
assert.equal(renderRequests, 2);

sidebar.close();
assert.equal(widgetCalls.at(-1)?.content, undefined);
assert.ok(overlayClosed);

assert.equal(createLongTaskSidebarController(undefined), undefined);
assert.equal(createLongTaskSidebarController({ hasUI: false } as never), undefined);

const fallbackWidgetCalls: Array<{ key: string; content: string[] | undefined; placement?: string }> = [];
let fallbackCustomCalled = false;
const fallbackSidebar = createLongTaskSidebarController({
  hasUI: true,
  mode: "json",
  ui: {
    setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
      fallbackWidgetCalls.push({ key, content, placement: options?.placement });
    },
    custom<T>(): Promise<T> {
      fallbackCustomCalled = true;
      throw new Error("overlay should not be registered outside TUI mode");
    },
  },
} as never);
assert.ok(fallbackSidebar);
assert.equal(fallbackCustomCalled, false);
assert.deepEqual(fallbackWidgetCalls[0], {
  key: "pi-long-task-sidebar",
  content: ["Pi Long Task: preparing sidebar..."],
  placement: "aboveEditor",
});
fallbackSidebar.update(sidebarUpdate);
assert.match(fallbackWidgetCalls.at(-1)?.content?.join("\n") ?? "", /active: ▢ TODO 2/);
fallbackSidebar.close();
assert.equal(fallbackWidgetCalls.at(-1)?.content, undefined);
