import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { runGoalLoop, type GoalLoopProgressUpdate, type GoalLoopRunResult } from "./goal_orchestrator.ts";
import { longTaskInputTransform } from "./input_router.ts";
import {
  formatGoalLoopResultMessage,
  goalTaskDetailsFromResult,
  renderGoalTaskToolCall,
  renderGoalTaskToolResult,
  renderLongTaskToolCall,
  renderLongTaskToolResult,
} from "./render.ts";
import { PiGoalTaskParams, PiLongTaskParams } from "./types.ts";

export function createWorkerCostAccumulator() {
  let pendingWorkerCostTotal = 0;

  return {
    add(cost: number): void {
      const value = finiteNonNegativeNumber(cost);
      if (value && value > 0) {
        pendingWorkerCostTotal += value;
      }
    },
    applyToAssistantMessage(message: AssistantMessage): AssistantMessage | undefined {
      if (pendingWorkerCostTotal <= 0) {
        return undefined;
      }

      const replacement = addWorkerCostToAssistantMessage(message, pendingWorkerCostTotal);
      if (replacement) {
        pendingWorkerCostTotal = 0;
      }
      return replacement;
    },
  };
}

export function addWorkerCostToAssistantMessage(
  message: AssistantMessage,
  workerCostTotal: number,
): AssistantMessage | undefined {
  const workerCost = finiteNonNegativeNumber(workerCostTotal);
  if (!workerCost || workerCost <= 0) {
    return undefined;
  }

  return {
    ...message,
    usage: {
      ...message.usage,
      cost: {
        ...message.usage.cost,
        total: message.usage.cost.total + workerCost,
      },
    },
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toolDetails(result: CoordinatorResult) {
  return {
    runId: result.runId,
    todoPath: result.todoPath,
    resultPath: result.resultPath,
    outcomes: result.outcomes,
    commits: result.commits,
    status: result.status,
    totalTasks: result.totalTasks,
    completedTasks: result.completedTasks,
    failedTasks: result.failedTasks,
    blockedTasks: result.blockedTasks,
    remainingTasks: result.remainingTasks,
    taskProgress: result.taskProgress,
    workerCostTotal: result.workerCostTotal,
    summary: result.summary,
    goal: result.goal,
    error: result.error,
  };
}

function goalLoopCostTotals(result: GoalLoopRunResult): {
  workerCostTotal: number;
  reviewerCostTotal: number;
  totalCost: number;
} {
  const workerCostTotal = sumFinite([
    ...result.generationResults.map((item) => item.childResult.workerCostTotal),
    ...result.executionResults.map((item) => item.childResult.workerCostTotal),
  ]);
  const reviewerCostTotal = sumFinite(result.reviewResults.map((item) => item.sessionResult.reviewerCostTotal));
  return { workerCostTotal, reviewerCostTotal, totalCost: workerCostTotal + reviewerCostTotal };
}

function goalToolDetails(result: GoalLoopRunResult) {
  return goalTaskDetailsFromResult({ ...result, ...goalLoopCostTotals(result) });
}

function sumFinite(values: Array<number | undefined>): number {
  return values.reduce<number>(
    (total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

const LONG_TASK_WIDGET_KEY = "pi-long-task-sidebar";
const SIDEBAR_WIDGET_RESERVED_INPUT_ROWS = 8;
const SIDEBAR_WIDGET_MIN_ROWS = 4;
const SIDEBAR_WIDGET_MAX_ROWS = 24;

type UiContext = ExtensionContext;

export interface LongTaskSidebarController {
  update(update: CoordinatorProgressUpdate): void;
  close(): void;
}

class PiLongTaskSidebarComponent implements Component {
  private readonly theme: Theme;
  private readonly maxRows: (() => number | undefined) | undefined;
  private update: CoordinatorProgressUpdate | undefined;

  constructor(theme: Theme, maxRows?: () => number | undefined) {
    this.theme = theme;
    this.maxRows = maxRows;
  }

  setUpdate(update: CoordinatorProgressUpdate): void {
    this.update = update;
    this.invalidate();
  }

  render(width: number): string[] {
    const lines = renderSidebarOverlayLines(this.update, this.theme, width);
    return limitSidebarPanelLines(lines, this.theme, width, this.maxRows?.());
  }

  invalidate(): void {
    // Rendering is derived from the latest progress update and current theme.
  }
}

export function createLongTaskSidebarController(ctx: UiContext | undefined): LongTaskSidebarController | undefined {
  if (!ctx?.hasUI) {
    return undefined;
  }

  let latestUpdate: CoordinatorProgressUpdate | undefined;
  let widgetComponent: PiLongTaskSidebarComponent | undefined;
  let widgetTui: TUI | undefined;
  let overlayComponent: PiLongTaskSidebarComponent | undefined;
  let overlayTui: TUI | undefined;
  let overlayDone: ((result: undefined) => void) | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let closed = false;

  if (supportsTuiWidget(ctx)) {
    ctx.ui.setWidget(
      LONG_TASK_WIDGET_KEY,
      (tui, theme) => {
        widgetTui = tui;
        widgetComponent = new PiLongTaskSidebarComponent(theme, () => sidebarWidgetLineLimit(tui));
        if (latestUpdate) {
          widgetComponent.setUpdate(latestUpdate);
        }
        return widgetComponent;
      },
      { placement: "aboveEditor" },
    );
  } else {
    ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, ["Pi Long Task: preparing sidebar..."], { placement: "aboveEditor" });
  }

  if (supportsTuiOverlay(ctx)) {
    try {
      const overlayPromise = ctx.ui.custom<undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          overlayDone = done;
          overlayComponent = new PiLongTaskSidebarComponent(theme);
          if (latestUpdate) {
            overlayComponent.setUpdate(latestUpdate);
          }
          if (closed) {
            done(undefined);
          }
          return overlayComponent;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "34%",
            minWidth: 32,
            maxHeight: "85%",
            margin: 1,
            nonCapturing: true,
            visible: (termWidth, termHeight) => termWidth >= 96 && termHeight >= 16,
          },
          onHandle: (handle) => {
            overlayHandle = handle;
            handle.unfocus();
          },
        },
      );
      void overlayPromise.catch(() => {
        // The widget fallback remains active if overlay registration is unavailable.
      });
    } catch {
      // The widget fallback remains active if overlay registration is unavailable.
    }
  }

  return {
    update(update: CoordinatorProgressUpdate): void {
      if (closed) {
        return;
      }
      latestUpdate = update;
      widgetComponent?.setUpdate(update);
      overlayComponent?.setUpdate(update);
      widgetTui?.requestRender();
      if (overlayTui && overlayTui !== widgetTui) {
        overlayTui.requestRender();
      }
      if (!widgetComponent) {
        ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, renderSidebarWidgetLines(update), { placement: "aboveEditor" });
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, undefined);
      if (overlayHandle) {
        overlayHandle.hide();
      } else {
        overlayDone?.(undefined);
      }
      widgetComponent = undefined;
      widgetTui = undefined;
      overlayComponent = undefined;
      overlayTui = undefined;
      overlayDone = undefined;
      overlayHandle = undefined;
    },
  };
}

function supportsTuiWidget(ctx: UiContext): boolean {
  const mode = (ctx as UiContext & { mode?: string }).mode;
  return mode === "tui" || mode === undefined;
}

function supportsTuiOverlay(ctx: UiContext): boolean {
  const mode = (ctx as UiContext & { mode?: string }).mode;
  return mode === "tui" || mode === undefined;
}

function sidebarWidgetLineLimit(tui: TUI): number {
  const terminalRows = tui.terminal.rows;
  const rows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 24;
  const availableRows = rows - SIDEBAR_WIDGET_RESERVED_INPUT_ROWS;
  return Math.max(SIDEBAR_WIDGET_MIN_ROWS, Math.min(SIDEBAR_WIDGET_MAX_ROWS, availableRows));
}

function renderSidebarWidgetLines(update: CoordinatorProgressUpdate): string[] {
  const progress = update.taskProgress;
  const summary = progress?.summary;
  const statusDetails = sidebarUpdateStateDetails(update);
  const lines = ["Pi Long Task", `${statusDetails.icon} ${statusDetails.label} · ${update.message}`];
  if (summary) {
    lines.push(
      `Tasks: ${summary.completedTasks}/${summary.totalTasks} · ${summary.completedPercent}%` +
        (summary.currentTasks ? ` · ${summary.currentTasks} active` : "") +
        (summary.pendingTasks ? ` · ${summary.pendingTasks} queued` : "") +
        (summary.failedTasks ? ` · ${summary.failedTasks} failed` : "") +
        (summary.blockedTasks ? ` · ${summary.blockedTasks} blocked` : ""),
    );
  }
  if (progress && progress.tasks.length > 0) {
    const currentIndex = focusedTaskIndex(progress);
    const currentTask = currentIndex >= 0 ? progress.tasks[currentIndex] : undefined;
    if (currentTask) {
      const details = taskStatusDetails(currentTask.status);
      lines.push(`${details.label}: ${details.icon} TODO ${currentTask.taskId} — ${currentTask.title}`);
    }
  }
  if (update.workerCostTotal > 0) {
    lines.push(`Spent: ${formatCost(update.workerCostTotal)}`);
  }
  return lines.map((line) => truncateToWidth(line, 96));
}

function renderSidebarOverlayLines(
  update: CoordinatorProgressUpdate | undefined,
  theme: Theme,
  width: number,
): string[] {
  const safeWidth = Math.max(28, width);
  const contentWidth = Math.max(8, safeWidth - 4);
  const rows = renderSidebarRows(update, theme, contentWidth);
  return rows.map((row) => sidebarPanelRow(row, contentWidth, theme));
}

function limitSidebarPanelLines(lines: string[], theme: Theme, width: number, maxRows: number | undefined): string[] {
  if (maxRows === undefined || !Number.isFinite(maxRows)) {
    return lines;
  }

  const limit = Math.max(0, Math.floor(maxRows));
  if (lines.length <= limit) {
    return lines;
  }
  if (limit === 0) {
    return [];
  }

  const contentWidth = Math.max(8, Math.max(28, width) - 4);
  if (limit === 1) {
    return [sidebarPanelRow(theme.fg("dim", "…"), contentWidth, theme)];
  }

  const visibleLines = lines.slice(0, limit - 1);
  const omitted = lines.length - visibleLines.length;
  visibleLines.push(sidebarPanelRow(theme.fg("dim", `… ${omitted} more`), contentWidth, theme));
  return visibleLines;
}

function renderSidebarRows(update: CoordinatorProgressUpdate | undefined, theme: Theme, width: number): string[] {
  if (!update) {
    return ["", sidebarHeading("Pi Long Task", theme), "", theme.fg("muted", "Preparing long-task sidebar...")];
  }

  const progress = update.taskProgress;
  const rows = [""];
  for (const line of wrapPlainText(sidebarHeadline(update, progress), width, 2)) {
    rows.push(sidebarHeading(line, theme));
  }
  rows.push(renderSidebarStateLine(update, theme));

  const message = normalizeMessageForSidebar(update.message, update);
  if (message) {
    rows.push(...wrapPlainText(message, width, 2).map((line) => theme.fg("dim", line)));
  }

  if (!progress || progress.tasks.length === 0) {
    rows.push("", sidebarHeading("Context", theme), theme.fg("muted", "Waiting for TODO plan"));
    if (update.workerCostTotal > 0) {
      rows.push(theme.fg("muted", `${formatCost(update.workerCostTotal)} spent`));
    }
    return rows;
  }

  const summary = progress.summary;
  rows.push(
    "",
    sidebarHeading("Context", theme),
    theme.fg(
      "muted",
      `${summary.completedTasks.toLocaleString()}/${summary.totalTasks.toLocaleString()} tasks complete`,
    ),
    theme.fg("muted", `${summary.completedPercent}% complete`),
  );
  if (update.workerCostTotal > 0) {
    rows.push(theme.fg("muted", `${formatCost(update.workerCostTotal)} spent`));
  }

  rows.push(
    "",
    sidebarHeading("Progress", theme),
    progressBarLine(progress, theme),
    progressCountsLine(summary, theme),
    progressStateLegend(progress, theme),
  );

  const currentIndex = focusedTaskIndex(progress);
  const currentTask = currentIndex >= 0 ? progress.tasks[currentIndex] : undefined;
  rows.push("", sidebarHeading("Current", theme));
  if (currentTask) {
    const details = taskStatusDetails(currentTask.status);
    rows.push(
      theme.fg(
        details.color,
        `${details.icon} TODO ${currentTask.taskId} ${theme.fg("dim", "·")} ${details.label}${currentTaskMeta(currentTask, theme)}`,
      ),
    );
    rows.push(...wrapPlainText(currentTask.title, width, 2).map((line) => theme.fg("muted", line)));
  } else {
    rows.push(theme.fg("success", "No active task"));
  }

  rows.push("", sidebarHeading("Task timeline", theme));
  const taskIndexes = centeredTaskIndexes(progress.tasks.length, currentIndex, 9);
  const first = taskIndexes[0] ?? 0;
  const last = taskIndexes[taskIndexes.length - 1] ?? -1;
  if (first > 0) {
    rows.push(theme.fg("dim", `… ${first} earlier task${first === 1 ? "" : "s"}`));
  }
  for (const index of taskIndexes) {
    const task = progress.tasks[index];
    if (task) {
      rows.push(renderTaskRow(task, index === currentIndex, theme));
    }
  }
  const remaining = progress.tasks.length - last - 1;
  if (remaining > 0) {
    rows.push(theme.fg("dim", `… ${remaining} later task${remaining === 1 ? "" : "s"}`));
  }

  const subtasks = update.subtasks ?? [];
  if (subtasks.length > 0) {
    rows.push("", sidebarHeading("Current status", theme));
    for (const subtask of subtasks.slice(0, 6)) {
      rows.push(renderSubtaskRow(subtask, theme));
    }
    if (subtasks.length > 6) {
      rows.push(theme.fg("dim", `… ${subtasks.length - 6} more`));
    }
  }

  return rows;
}

function centeredTaskIndexes(total: number, currentIndex: number, limit: number): number[] {
  if (total <= 0) {
    return [];
  }
  const clampedLimit = Math.max(1, Math.min(total, limit));
  const focus = currentIndex >= 0 ? currentIndex : 0;
  const start = Math.max(0, Math.min(total - clampedLimit, focus - Math.floor(clampedLimit / 2)));
  return Array.from({ length: clampedLimit }, (_value, index) => start + index);
}

function focusedTaskIndex(progress: NonNullable<CoordinatorProgressUpdate["taskProgress"]>): number {
  if (typeof progress.currentIndex === "number" && progress.currentIndex >= 0) {
    return progress.currentIndex;
  }
  if (typeof progress.nextIndex === "number" && progress.nextIndex >= 0) {
    return progress.nextIndex;
  }
  return progress.tasks.findIndex((task) => task.status === "current" || task.position === "current");
}

function renderTaskRow(
  task: NonNullable<CoordinatorProgressUpdate["taskProgress"]>["tasks"][number],
  focused: boolean,
  theme: Theme,
): string {
  const details = taskStatusDetails(task.status);
  const attempts = task.attempts > 0 && task.status !== "completed" ? ` ${theme.fg("dim", "·")} ${task.attempts}x` : "";
  const title = truncateToWidth(task.title, 72);
  const focusMarker = focused ? theme.fg("accent", "›") : theme.fg("dim", " ");
  const icon = theme.fg(details.color, details.icon);
  const label = `TODO ${task.taskId}`;
  const row = `${label} ${theme.fg("dim", "·")} ${details.label} ${theme.fg("dim", "·")} ${title}${attempts}`;
  const styledRow = focused ? theme.fg(details.color, theme.bold(row)) : theme.fg(details.textColor, row);
  return `${focusMarker} ${icon} ${styledRow}`;
}

function renderSubtaskRow(subtask: NonNullable<CoordinatorProgressUpdate["subtasks"]>[number], theme: Theme): string {
  const details = progressItemStatusDetails(subtask.status);
  return `${theme.fg(details.color, details.icon)} ${theme.fg(details.textColor, `${details.label} · ${subtask.text}`)}`;
}

function renderSidebarStateLine(update: CoordinatorProgressUpdate, theme: Theme): string {
  const details = sidebarUpdateStateDetails(update);
  const suffix = [
    update.attempt && update.attempt > 1 ? `attempt ${update.attempt}` : undefined,
    update.workerCostTotal > 0 ? `${formatCost(update.workerCostTotal)} spent` : undefined,
  ]
    .filter(Boolean)
    .join(` ${theme.fg("dim", "·")} `);
  const meta = suffix ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", suffix)}` : "";
  return `${theme.fg(details.color, details.icon)} ${theme.fg(details.color, details.label)}${meta}`;
}

function currentTaskMeta(
  task: NonNullable<CoordinatorProgressUpdate["taskProgress"]>["tasks"][number],
  theme: Theme,
): string {
  const attempts = task.attempts > 0 && task.status !== "completed" ? [`attempt ${task.attempts}`] : [];
  if (task.lastReportedStatus && task.status !== "current") {
    attempts.push(task.lastReportedStatus);
  }
  return attempts.length > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", attempts.join(" · "))}` : "";
}

function progressMeterLine(progress: NonNullable<CoordinatorProgressUpdate["taskProgress"]>, theme: Theme): string {
  const total = progress.tasks.length;
  if (total === 0) {
    return theme.fg("dim", "────────");
  }

  const maxSegments = 12;
  const step = Math.max(1, Math.ceil(total / maxSegments));
  const segments: string[] = [];
  for (let index = 0; index < total; index += step) {
    const slice = progress.tasks.slice(index, Math.min(total, index + step));
    segments.push(progressMeterSegment(slice, theme));
  }
  return segments.join("");
}

function progressMeterSegment(
  tasks: Array<NonNullable<CoordinatorProgressUpdate["taskProgress"]>["tasks"][number]>,
  theme: Theme,
): string {
  if (tasks.some((task) => task.status === "failed")) {
    return theme.fg("error", "×");
  }
  if (tasks.some((task) => task.status === "blocked")) {
    return theme.fg("warning", "!");
  }
  if (tasks.some((task) => task.status === "current")) {
    return theme.fg("accent", "▢");
  }
  if (tasks.every((task) => task.status === "completed")) {
    return theme.fg("success", "■");
  }
  if (tasks.some((task) => task.status === "completed")) {
    return theme.fg("success", "▪");
  }
  return theme.fg("dim", "·");
}

function progressStateLegend(progress: NonNullable<CoordinatorProgressUpdate["taskProgress"]>, theme: Theme): string {
  const statuses = new Set(progress.tasks.map((task) => task.status));
  const items = [
    statuses.has("completed") ? theme.fg("success", "■ done") : undefined,
    statuses.has("current") ? theme.fg("accent", "▢ active") : undefined,
    statuses.has("pending") ? theme.fg("dim", "· queued") : undefined,
    statuses.has("failed") ? theme.fg("error", "× failed") : undefined,
    statuses.has("blocked") ? theme.fg("warning", "! blocked") : undefined,
  ].filter(Boolean);
  return theme.fg("muted", items.join(" · "));
}

function sidebarUpdateStateDetails(update: CoordinatorProgressUpdate): {
  icon: string;
  label: string;
  color: "accent" | "success" | "warning" | "error" | "muted";
} {
  if (update.status) {
    switch (update.status) {
      case "done":
        return { icon: "✓", label: "done", color: "success" };
      case "failed":
        return { icon: "×", label: "failed", color: "error" };
      case "blocked":
        return { icon: "!", label: "blocked", color: "warning" };
      case "partial":
        return { icon: "!", label: "partial", color: "warning" };
    }
  }

  switch (update.phase) {
    case "planning":
      return { icon: "+", label: "Planning", color: "warning" };
    case "planned":
      return { icon: "✓", label: "Plan ready", color: "success" };
    case "task_start":
      return { icon: "▢", label: "Running task", color: "accent" };
    case "worker_tool":
      return { icon: "+", label: "Worker tool", color: "warning" };
    case "task_done":
      return { icon: "✓", label: "Task complete", color: "success" };
    case "task_blocked":
      return { icon: "!", label: "Task blocked", color: "warning" };
    case "task_failed":
      return { icon: "×", label: "Task failed", color: "error" };
    case "complete":
      return { icon: "✓", label: "Complete", color: "success" };
  }
}

function taskStatusDetails(status: NonNullable<CoordinatorProgressUpdate["taskProgress"]>["tasks"][number]["status"]): {
  icon: string;
  label: string;
  color: "accent" | "success" | "warning" | "error" | "dim" | "muted";
  textColor: "accent" | "text" | "success" | "warning" | "error" | "dim" | "muted";
} {
  switch (status) {
    case "completed":
      return { icon: "✓", label: "done", color: "success", textColor: "muted" };
    case "current":
      return { icon: "▢", label: "active", color: "accent", textColor: "text" };
    case "failed":
      return { icon: "×", label: "failed", color: "error", textColor: "error" };
    case "blocked":
      return { icon: "!", label: "blocked", color: "warning", textColor: "warning" };
    case "pending":
      return { icon: "○", label: "queued", color: "dim", textColor: "dim" };
  }
}

function progressItemStatusDetails(status: NonNullable<CoordinatorProgressUpdate["subtasks"]>[number]["status"]): {
  icon: string;
  label: string;
  color: "success" | "warning" | "error" | "dim" | "muted";
  textColor: "success" | "warning" | "error" | "dim" | "muted";
} {
  switch (status) {
    case "done":
      return { icon: "✓", label: "done", color: "success", textColor: "muted" };
    case "in_progress":
      return { icon: "+", label: "active", color: "warning", textColor: "warning" };
    case "failed":
      return { icon: "×", label: "failed", color: "error", textColor: "error" };
    case "blocked":
      return { icon: "!", label: "blocked", color: "warning", textColor: "warning" };
    case "empty":
      return { icon: "○", label: "queued", color: "dim", textColor: "dim" };
  }
}

function progressBarLine(progress: NonNullable<CoordinatorProgressUpdate["taskProgress"]>, theme: Theme): string {
  const summary = progress.summary;
  return `${theme.fg("muted", "Tasks")} ${theme.fg(
    "success",
    `${summary.completedTasks}/${summary.totalTasks}`,
  )} ${theme.fg("dim", "·")} ${theme.fg("muted", `${summary.completedPercent}% complete`)} ${theme.fg(
    "dim",
    "·",
  )} ${progressMeterLine(progress, theme)}`;
}

function progressCountsLine(
  summary: NonNullable<NonNullable<CoordinatorProgressUpdate["taskProgress"]>["summary"]>,
  theme: Theme,
): string {
  return [
    theme.fg("success", `✓ ${summary.completedTasks} done`),
    summary.currentTasks ? theme.fg("accent", `▢ ${summary.currentTasks} active`) : undefined,
    summary.pendingTasks ? theme.fg("dim", `○ ${summary.pendingTasks} queued`) : undefined,
    summary.failedTasks ? theme.fg("error", `× ${summary.failedTasks} failed`) : undefined,
    summary.blockedTasks ? theme.fg("warning", `! ${summary.blockedTasks} blocked`) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function sidebarHeading(text: string, theme: Theme): string {
  return theme.fg("toolTitle", theme.bold(text));
}

function sidebarHeadline(
  update: CoordinatorProgressUpdate,
  progress: CoordinatorProgressUpdate["taskProgress"],
): string {
  if (update.taskId && update.title) {
    return `TODO ${update.taskId} — ${update.title}`;
  }
  const currentTask = progress?.currentTask ?? progress?.nextTask;
  if (currentTask) {
    return `TODO ${currentTask.taskId} — ${currentTask.title}`;
  }
  return "Pi Long Task";
}

function normalizeMessageForSidebar(updateMessage: string, update: CoordinatorProgressUpdate): string | undefined {
  const message = updateMessage.trim();
  if (!message) {
    return undefined;
  }
  const title = update.taskId && update.title ? `TODO ${update.taskId} — ${update.title}` : undefined;
  return title && message.includes(title) && message.length <= title.length + 16 ? undefined : message;
}

function wrapPlainText(text: string, width: number, limit?: number): string[] {
  const safeWidth = Math.max(8, width);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= safeWidth) {
      line = next;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    line = word.length > safeWidth ? truncateToWidth(word, safeWidth) : word;
    if (limit && lines.length >= limit) {
      break;
    }
  }
  if (line && (!limit || lines.length < limit)) {
    lines.push(line);
  }
  if (limit && lines.length > limit) {
    lines.length = limit;
  }
  if (limit && words.join(" ").length > lines.join(" ").length && lines.length > 0) {
    lines[lines.length - 1] = truncateToWidth(`${lines[lines.length - 1]} …`, safeWidth);
  }
  return lines;
}

function sidebarPanelRow(text: string, width: number, theme: Theme): string {
  return `${theme.fg("borderMuted", "│")}  ${truncateToWidth(text, width, "…", true)}`;
}

function formatCost(value: number): string {
  if (value === 0) {
    return "$0";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

export default function registerPiLongTaskExtension(pi: ExtensionAPI) {
  const workerCostAccumulator = createWorkerCostAccumulator();

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return undefined;
    }

    const message = workerCostAccumulator.applyToAssistantMessage(event.message);
    return message ? { message } : undefined;
  });

  pi.on("input", (event) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }

    const transformed = longTaskInputTransform(event.text);
    if (!transformed) {
      return { action: "continue" as const };
    }

    return { action: "transform" as const, text: transformed };
  });

  pi.registerTool({
    name: "pi_long_task",
    label: "Pi Long Task",
    description:
      "Run long or multi-step coding tasks from a request or TODO plan. Use this when the user asks to run/start/handle a long task; set commit true only when they ask for commits or committing as work progresses.",
    parameters: PiLongTaskParams,
    renderCall: renderLongTaskToolCall,
    renderResult: renderLongTaskToolResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sidebar = createLongTaskSidebarController(ctx);
      const publishProgress = (update: CoordinatorProgressUpdate) => {
        sidebar?.update(update);
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: update.message,
            },
          ],
          details: update,
        });
      };

      try {
        const result = await runCoordinator({
          ...params,
          cwd: ctx?.cwd,
          workerModel: ctx?.model,
          abortSignal: signal,
          onProgress: publishProgress,
        });
        workerCostAccumulator.add(result.workerCostTotal);

        return {
          content: [
            {
              type: "text" as const,
              text: result.message,
            },
          ],
          details: toolDetails(result),
        };
      } finally {
        sidebar?.close();
      }
    },
  });

  pi.registerTool({
    name: "pi_goal_task",
    label: "Pi Goal Task",
    description:
      "Run a goal-oriented long-task loop: generate TODO markdown from a high-level goal, execute it, review goal completion, and repeat until complete, cancelled, timed out, or max iterations is reached. Pass the tool cancellation signal to stop the loop.",
    parameters: PiGoalTaskParams,
    renderCall: renderGoalTaskToolCall,
    renderResult: renderGoalTaskToolResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sidebar = createLongTaskSidebarController(ctx);
      const publishGoalProgress = (update: GoalLoopProgressUpdate) => {
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: update.message,
            },
          ],
          details: update,
        });
      };
      const publishWorkerProgress = (update: CoordinatorProgressUpdate) => {
        sidebar?.update(update);
      };

      try {
        const result = await runGoalLoop({
          ...params,
          commit: params.commit ?? true,
          cwd: ctx?.cwd,
          model: ctx?.model,
          abortSignal: signal,
          onProgress: publishGoalProgress,
          onWorkerProgress: publishWorkerProgress,
        });
        const costs = goalLoopCostTotals(result);
        workerCostAccumulator.add(costs.totalCost);
        const message = formatGoalLoopResultMessage({ ...result, ...costs });

        return {
          content: [
            {
              type: "text" as const,
              text: message,
            },
          ],
          details: goalToolDetails(result),
        };
      } finally {
        sidebar?.close();
      }
    },
  });
}
