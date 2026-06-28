import assert from "node:assert/strict";

import registerPiLongTaskExtension, {
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

interface RegisteredLongTaskTool {
  name?: string;
  parameters?: {
    required?: string[];
    properties?: Record<string, { description?: string; type?: string }>;
  };
}

const registeredEvents: string[] = [];
const registeredTools: RegisteredLongTaskTool[] = [];
registerPiLongTaskExtension({
  on(event: string) {
    registeredEvents.push(event);
  },
  registerTool(tool: RegisteredLongTaskTool) {
    registeredTools.push(tool);
  },
} as unknown as Parameters<typeof registerPiLongTaskExtension>[0]);
const longTaskTool = registeredTools.find((tool) => tool.name === "pi_long_task");
assert.ok(longTaskTool);
assert.deepEqual(longTaskTool.parameters?.required, ["commit"]);
assert.equal(longTaskTool.parameters?.properties?.inputText?.type, "string");
assert.doesNotMatch(longTaskTool.parameters?.properties?.inputText?.description ?? "", /required/i);
assert.equal(longTaskTool.parameters?.properties?.goal?.type, "string");
assert.match(longTaskTool.parameters?.properties?.goal?.description ?? "", /Optional high-level goal/);
const goalTaskTool = registeredTools.find((tool) => tool.name === "pi_goal_task");
assert.ok(goalTaskTool);
assert.deepEqual(goalTaskTool.parameters?.required, ["goal"]);
assert.equal(goalTaskTool.parameters?.properties?.goal?.type, "string");
assert.match(goalTaskTool.parameters?.properties?.goal?.description ?? "", /High-level goal/);
assert.equal(goalTaskTool.parameters?.properties?.maxIterations?.type, "integer");
assert.match(goalTaskTool.parameters?.properties?.reviewerTimeoutMs?.description ?? "", /reviewer session/);
assert.deepEqual(registeredEvents, ["message_end", "input"]);

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

const widgetCalls: Array<{ key: string; content: WidgetContent; placement?: string }> = [];
let widgetComponent: Component | undefined;
let widgetFactoryCalls = 0;
let renderRequests = 0;
let overlayRenderRequests = 0;
let overlayHideCalls = 0;
let overlayUnfocusCalls = 0;
let overlayComponent: Component | undefined;
const customCalls: Array<{
  overlay?: boolean;
  anchor?: string;
  width?: string;
  minWidth?: number;
  maxHeight?: string;
  margin?: number;
  nonCapturing?: boolean;
  visibleAtWide?: boolean;
  visibleAtNarrowWidth?: boolean;
  visibleAtShortHeight?: boolean;
}> = [];
const sidebarTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const sidebarTui = {
  terminal: { rows: 40 },
  requestRender: () => {
    renderRequests += 1;
  },
} as unknown as TUI;
const overlayTui = {
  terminal: { rows: 40 },
  requestRender: () => {
    overlayRenderRequests += 1;
  },
} as unknown as TUI;
const sidebar = createLongTaskSidebarController({
  hasUI: true,
  mode: "tui",
  ui: {
    setWidget(key: string, content: WidgetContent, options?: { placement?: string }) {
      widgetCalls.push({ key, content, placement: options?.placement });
      if (typeof content === "function") {
        widgetFactoryCalls += 1;
        widgetComponent = content(sidebarTui, sidebarTheme);
      } else if (!content) {
        widgetComponent = undefined;
      }
    },
    custom<T>(
      factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          anchor?: string;
          width?: string;
          minWidth?: number;
          maxHeight?: string;
          margin?: number;
          nonCapturing?: boolean;
          visible?: (termWidth: number, termHeight: number) => boolean;
        };
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T> {
      const visible = options?.overlayOptions?.visible;
      customCalls.push({
        overlay: options?.overlay,
        anchor: options?.overlayOptions?.anchor,
        width: options?.overlayOptions?.width,
        minWidth: options?.overlayOptions?.minWidth,
        maxHeight: options?.overlayOptions?.maxHeight,
        margin: options?.overlayOptions?.margin,
        nonCapturing: options?.overlayOptions?.nonCapturing,
        visibleAtWide: visible?.(120, 32),
        visibleAtNarrowWidth: visible?.(95, 32),
        visibleAtShortHeight: visible?.(120, 15),
      });
      return new Promise<T>((resolve) => {
        overlayComponent = factory(overlayTui, sidebarTheme, {}, resolve);
        options?.onHandle?.({
          hide() {
            overlayHideCalls += 1;
          },
          setHidden() {},
          isHidden: () => false,
          focus() {},
          unfocus() {
            overlayUnfocusCalls += 1;
          },
          isFocused: () => false,
        });
      });
    },
  },
} as never);

assert.ok(sidebar);
assert.deepEqual(
  customCalls[0],
  {
    overlay: true,
    anchor: "right-center",
    width: "34%",
    minWidth: 32,
    maxHeight: "85%",
    margin: 1,
    nonCapturing: true,
    visibleAtWide: true,
    visibleAtNarrowWidth: false,
    visibleAtShortHeight: false,
  },
  "TUI mode should register a responsive non-capturing right-side overlay sidebar",
);
assert.equal(overlayUnfocusCalls, 1, "sidebar overlay should not steal focus from the active session");
assert.equal(widgetCalls[0]?.key, "pi-long-task-sidebar");
assert.equal(typeof widgetCalls[0]?.content, "function");
assert.equal(widgetCalls[0]?.placement, "aboveEditor");
assert.equal(widgetFactoryCalls, 1);
assert.match(widgetComponent?.render(80).join("\n") ?? "", /Preparing long-task sidebar/);

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
const runningWidgetLines = widgetComponent?.render(80) ?? [];
const runningWidget = runningWidgetLines.join("\n");
assert.match(runningWidget, /TODO 2 — Wire Sidebar Rendering/);
assert.match(runningWidget, /▢ Running task .* \$0\.01 spent/);
assert.match(runningWidget, /Task timeline/);
assert.match(runningWidget, /Current/);
assert.match(runningWidget, /Tasks 1\/3 .* 33% complete .* ■▢·/);
assert.match(runningWidget, /■ done .* ▢ active .* · queued/);
assert.match(runningWidget, /▢ TODO 2 .* active/);
assert.match(runningWidget, /› ▢ TODO 2/);
assert.match(runningWidget, /Wire Sidebar Rendering/);
assert.match(runningWidget, /… 2 more/);
const runningOverlay = overlayComponent?.render(96).join("\n") ?? "";
assert.match(runningOverlay, /TODO 2 — Wire Sidebar Rendering/);
assert.match(runningOverlay, /Task timeline/);
assert.match(runningOverlay, /› ▢ TODO 2/);
assert.equal(renderRequests, 1);
assert.equal(overlayRenderRequests, 1);
assert.ok(runningWidgetLines.length > 6);
assert.ok(runningWidgetLines.length <= 24, "sidebar should cap its height even on tall terminals");
(sidebarTui as unknown as { terminal: { rows: number } }).terminal.rows = 14;
const constrainedWidgetLines = widgetComponent?.render(80) ?? [];
assert.equal(constrainedWidgetLines.length, 6, "sidebar should reserve 8 terminal rows for editor/input");
assert.match(constrainedWidgetLines.at(-1) ?? "", /… \d+ more/);
(sidebarTui as unknown as { terminal: { rows: number } }).terminal.rows = 40;

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
const doneWidget = widgetComponent?.render(80).join("\n") ?? "";
assert.match(doneWidget, /✓ done/);
assert.match(doneWidget, /2\/3 tasks complete/);
assert.match(doneWidget, /67% complete/);
assert.equal(renderRequests, 2);
assert.equal(overlayRenderRequests, 2);

sidebar.close();
assert.equal(widgetCalls.at(-1)?.content, undefined);
assert.equal(widgetComponent, undefined);
assert.equal(overlayHideCalls, 1);

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
