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
  const status = update.status ? String(update.status) : update.phase;
  const lines = [`Pi Long Task: ${status}`, update.message];
  if (summary) {
    lines.push(
      `Tasks: ${summary.completedTasks}/${summary.totalTasks} done` +
        (summary.failedTasks ? `, ${summary.failedTasks} failed` : "") +
        (summary.blockedTasks ? `, ${summary.blockedTasks} blocked` : ""),
    );
  }
  if (progress && progress.tasks.length > 0) {
    const currentIndex = focusedTaskIndex(progress);
    const currentTask = currentIndex >= 0 ? progress.tasks[currentIndex] : undefined;
    if (currentTask) {
      lines.push(`Focus: TODO ${currentTask.taskId} — ${currentTask.title}`);
    }
  }
  if (update.workerCostTotal > 0) {
    lines.push(`Worker spend: ${formatCost(update.workerCostTotal)}`);
  }
  return lines.map((line) => truncateToWidth(line, 96));
}

function renderSidebarOverlayLines(
  update: CoordinatorProgressUpdate | undefined,
  theme: Theme,
  width: number,
): string[] {
  const safeWidth = Math.max(12, width);
  const innerWidth = Math.max(0, safeWidth - 2);
  const rows = renderSidebarRows(update, theme);
  return [
    sidebarBorder("Pi Long Task", safeWidth, theme),
    ...rows.map((row) => sidebarRow(row, innerWidth, theme)),
    theme.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`),
  ];
}

function renderSidebarRows(update: CoordinatorProgressUpdate | undefined, theme: Theme): string[] {
  if (!update) {
    return [theme.fg("muted", "Preparing long-task sidebar...")];
  }

  const progress = update.taskProgress;
  const rows = [theme.fg("toolTitle", theme.bold("Task timeline")), theme.fg("dim", update.phase)];
  if (update.workerCostTotal > 0) {
    rows.push(theme.fg("muted", `Worker spend: ${formatCost(update.workerCostTotal)}`));
  }
  rows.push("", theme.fg("muted", truncateToWidth(update.message, 72)));

  if (!progress || progress.tasks.length === 0) {
    rows.push("", theme.fg("muted", "Waiting for TODO plan..."));
    return rows;
  }

  const summary = progress.summary;
  rows.push("", progressBarLine(summary.completedTasks, summary.totalTasks, summary.completedPercent, theme));
  rows.push(progressCountsLine(summary, theme));

  const currentIndex = focusedTaskIndex(progress);
  if (currentIndex >= 0) {
    rows.push(theme.fg("warning", `Focus: TODO ${progress.tasks[currentIndex]?.taskId ?? "?"}`));
  } else {
    rows.push(theme.fg("success", "No active task"));
  }

  rows.push("", theme.fg("muted", "Tasks"));
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
    rows.push("", theme.fg("muted", "Current status"));
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
  const attempts = task.attempts > 0 && task.status !== "completed" ? ` · ${task.attempts}x` : "";
  const row = `${details.icon} TODO ${task.taskId} — ${task.title}${attempts}`;
  const styled = focused ? theme.bold(row) : row;
  return theme.fg(details.color, styled);
}

function renderSubtaskRow(subtask: NonNullable<CoordinatorProgressUpdate["subtasks"]>[number], theme: Theme): string {
  const details = progressItemStatusDetails(subtask.status);
  return theme.fg(details.color, `${details.icon} ${subtask.text}`);
}

function taskStatusDetails(status: NonNullable<CoordinatorProgressUpdate["taskProgress"]>["tasks"][number]["status"]): {
  icon: string;
  color: "success" | "warning" | "error" | "dim" | "muted";
} {
  switch (status) {
    case "completed":
      return { icon: "✓", color: "success" };
    case "current":
      return { icon: "▶", color: "warning" };
    case "failed":
      return { icon: "✗", color: "error" };
    case "blocked":
      return { icon: "!", color: "warning" };
    case "pending":
      return { icon: "○", color: "dim" };
  }
}

function progressItemStatusDetails(status: NonNullable<CoordinatorProgressUpdate["subtasks"]>[number]["status"]): {
  icon: string;
  color: "success" | "warning" | "error" | "dim" | "muted";
} {
  switch (status) {
    case "done":
      return { icon: "✓", color: "success" };
    case "in_progress":
      return { icon: "▶", color: "warning" };
    case "failed":
      return { icon: "✗", color: "error" };
    case "blocked":
      return { icon: "!", color: "warning" };
    case "empty":
      return { icon: "○", color: "dim" };
  }
}

function progressBarLine(completedTasks: number, totalTasks: number, percent: number, theme: Theme): string {
  const width = 12;
  const filled = clamp(totalTasks === 0 ? width : Math.round((completedTasks / totalTasks) * width), 0, width);
  const empty = Math.max(0, width - filled);
  return `${theme.fg("muted", "Progress")} [${theme.fg("success", "#".repeat(filled))}${theme.fg(
    "dim",
    "-".repeat(empty),
  )}] ${completedTasks}/${totalTasks} ${percent}%`;
}

function progressCountsLine(
  summary: NonNullable<NonNullable<CoordinatorProgressUpdate["taskProgress"]>["summary"]>,
  theme: Theme,
): string {
  return [
    theme.fg("success", `✓ ${summary.completedTasks}`),
    summary.currentTasks ? theme.fg("warning", `▶ ${summary.currentTasks}`) : undefined,
    summary.pendingTasks ? theme.fg("dim", `○ ${summary.pendingTasks}`) : undefined,
    summary.failedTasks ? theme.fg("error", `✗ ${summary.failedTasks}`) : undefined,
    summary.blockedTasks ? theme.fg("warning", `! ${summary.blockedTasks}`) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function sidebarBorder(title: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  const label = ` ${title} `;
  const safeLabel = truncateToWidth(label, innerWidth, "");
  const remainder = Math.max(0, innerWidth - safeLabel.length);
  return theme.fg("borderMuted", `┌${safeLabel}${"─".repeat(remainder)}┐`);
}

function sidebarRow(text: string, width: number, theme: Theme): string {
  return `${theme.fg("borderMuted", "│")}${truncateToWidth(text, width, "…", true)}${theme.fg("borderMuted", "│")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
