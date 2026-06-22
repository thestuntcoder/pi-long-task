import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { longTaskInputTransform } from "./input_router.ts";
import { renderLongTaskToolCall, renderLongTaskToolResult } from "./render.ts";
import { PiLongTaskParams } from "./types.ts";

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
  };
}

const LONG_TASK_WIDGET_KEY = "pi-long-task-sidebar";

type UiContext = ExtensionContext;

export interface LongTaskSidebarController {
  update(update: CoordinatorProgressUpdate): void;
  close(): void;
}

class PiLongTaskSidebarComponent implements Component {
  private readonly theme: Theme;
  private update: CoordinatorProgressUpdate | undefined;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setUpdate(update: CoordinatorProgressUpdate): void {
    this.update = update;
    this.invalidate();
  }

  render(width: number): string[] {
    return renderSidebarOverlayLines(this.update, this.theme, width);
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
  let overlayComponent: PiLongTaskSidebarComponent | undefined;
  let overlayTui: TUI | undefined;
  let overlayDone: ((result: undefined) => void) | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let closed = false;

  ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, ["Pi Long Task: preparing sidebar..."], { placement: "aboveEditor" });

  if (supportsTuiOverlay(ctx)) {
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
          minWidth: 36,
          maxHeight: "100%",
          margin: 0,
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
  }

  return {
    update(update: CoordinatorProgressUpdate): void {
      if (closed) {
        return;
      }
      latestUpdate = update;
      overlayComponent?.setUpdate(update);
      overlayTui?.requestRender();
      ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, renderSidebarWidgetLines(update), { placement: "aboveEditor" });
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      ctx.ui.setWidget(LONG_TASK_WIDGET_KEY, undefined);
      if (overlayDone) {
        overlayDone(undefined);
      } else {
        overlayHandle?.hide();
      }
      overlayComponent = undefined;
      overlayTui = undefined;
      overlayDone = undefined;
      overlayHandle = undefined;
    },
  };
}

function supportsTuiOverlay(ctx: UiContext): boolean {
  const mode = (ctx as UiContext & { mode?: string }).mode;
  return mode === "tui" || mode === undefined;
}

function renderSidebarWidgetLines(update: CoordinatorProgressUpdate): string[] {
  const progress = update.taskProgress;
  const summary = progress?.summary;
  const status = update.status ? String(update.status) : phaseLabel(update.phase);
  const lines = ["Pi Long Task", `${status} · ${update.message}`];
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

function renderSidebarRows(update: CoordinatorProgressUpdate | undefined, theme: Theme, width: number): string[] {
  if (!update) {
    return ["", sidebarHeading("Pi Long Task", theme), "", theme.fg("muted", "Preparing long-task sidebar...")];
  }

  const progress = update.taskProgress;
  const rows = [""];
  for (const line of wrapPlainText(sidebarHeadline(update, progress), width, 2)) {
    rows.push(sidebarHeading(line, theme));
  }
  rows.push(theme.fg("muted", `Pi Long Task · ${phaseLabel(update.phase)}`));

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

  rows.push("", sidebarHeading("Progress", theme), progressBarLine(summary, theme), progressCountsLine(summary, theme));

  const currentIndex = focusedTaskIndex(progress);
  const currentTask = currentIndex >= 0 ? progress.tasks[currentIndex] : undefined;
  rows.push("", sidebarHeading("Current", theme));
  if (currentTask) {
    const details = taskStatusDetails(currentTask.status);
    rows.push(
      theme.fg(details.color, `${details.icon} TODO ${currentTask.taskId} ${theme.fg("dim", "·")} ${details.label}`),
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
  const icon = theme.fg(details.color, details.icon);
  const label = `TODO ${task.taskId}`;
  const row = `${label} ${theme.fg("dim", "·")} ${details.label} ${theme.fg("dim", "·")} ${title}${attempts}`;
  const styledRow = focused ? theme.fg(details.color, theme.bold(row)) : theme.fg(details.textColor, row);
  return `${icon} ${styledRow}`;
}

function renderSubtaskRow(subtask: NonNullable<CoordinatorProgressUpdate["subtasks"]>[number], theme: Theme): string {
  const details = progressItemStatusDetails(subtask.status);
  return `${theme.fg(details.color, details.icon)} ${theme.fg(details.textColor, `${details.label} · ${subtask.text}`)}`;
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

function progressBarLine(
  summary: NonNullable<NonNullable<CoordinatorProgressUpdate["taskProgress"]>["summary"]>,
  theme: Theme,
): string {
  return `${theme.fg("muted", "Tasks")} ${theme.fg(
    "success",
    `${summary.completedTasks}/${summary.totalTasks}`,
  )} ${theme.fg("dim", "·")} ${theme.fg("muted", `${summary.completedPercent}% complete`)}`;
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

function phaseLabel(phase: CoordinatorProgressUpdate["phase"]): string {
  switch (phase) {
    case "planning":
      return "Planning";
    case "planned":
      return "Plan ready";
    case "task_start":
      return "Running task";
    case "worker_tool":
      return "Worker tool";
    case "task_done":
      return "Task complete";
    case "task_blocked":
      return "Task blocked";
    case "task_failed":
      return "Task failed";
    case "complete":
      return "Complete";
  }
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
}
