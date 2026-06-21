import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type { TaskProgressModel } from "./task_progress.ts";
import type { CoordinatorCommitSummary, CoordinatorRemainingTask, CoordinatorStatus } from "./types.ts";

export interface CoordinatorResultForRendering {
  status: CoordinatorStatus;
  summary: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  todoPath: string;
  resultPath?: string;
  taskResultPath?: string;
  commits?: CoordinatorCommitSummary[];
  remainingTasks?: CoordinatorRemainingTask[];
  taskProgress?: TaskProgressModel;
  workerCostTotal?: number;
  error?: string;
}

export interface CoordinatorToolRenderDetails extends CoordinatorResultForRendering {
  runId?: string;
}

type ProgressItemStatus = "empty" | "in_progress" | "done" | "failed" | "blocked";

interface ProgressTaskRenderDetails {
  taskId: string;
  title: string;
  status: ProgressItemStatus;
}

interface ProgressSubtaskRenderDetails {
  text: string;
  status: ProgressItemStatus;
}

export function formatCoordinatorResultMessage(result: CoordinatorResultForRendering): string {
  const resultPath = result.resultPath ?? result.taskResultPath ?? "unknown";
  const remaining = result.remainingTasks ?? [];
  const commits = result.commits ?? [];
  const remainingCount = Math.max(0, result.totalTasks - result.completedTasks);
  const lines = [
    `Pi Long Task: ${result.status}`,
    `Tasks: ${result.completedTasks} completed, ${result.failedTasks} failed, ${result.blockedTasks} blocked, ${remainingCount} remaining (${result.totalTasks} total).`,
    `Result file: ${resultPath}`,
    `TODO file: ${result.todoPath}`,
  ];

  if (result.workerCostTotal) {
    lines.push(`Worker spend: ${formatCost(result.workerCostTotal)}`);
  }

  const commitLines = commits
    .filter((commit) => commit.hash || commit.error)
    .map((commit) => {
      if (commit.hash) {
        return `- TODO ${commit.taskId}: ${commit.hash}`;
      }
      return `- TODO ${commit.taskId}: commit error: ${commit.error ?? "unknown"}`;
    });
  if (commitLines.length > 0) {
    lines.push("Commits:", ...commitLines);
  }

  if (remaining.length > 0) {
    lines.push(
      "Remaining tasks:",
      ...remaining.map((task) => `- TODO ${task.taskId} — ${task.title} (${task.status})`),
    );
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  return lines.join("\n");
}

export function renderLongTaskToolCall(args: { inputText?: string; commit?: boolean }, theme: Theme): Text {
  const commit = args.commit ? theme.fg("warning", "commit:on") : theme.fg("dim", "commit:off");
  const input = oneLine(args.inputText ?? "");
  const preview = input ? ` ${theme.fg("muted", quote(truncatePlain(input, 96)))}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("pi_long_task"))} ${commit}${preview}`, 0, 0);
}

export function renderLongTaskToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = recordOrUndefined(result.details);
  if (options.isPartial) {
    return new Text(renderLongTaskProgress(details, contentText(result), theme), 0, 0);
  }

  const finalDetails = longTaskDetails(details);
  if (!finalDetails) {
    return new Text(contentText(result), 0, 0);
  }

  return new Text(renderLongTaskSummary(finalDetails, options.expanded, theme), 0, 0);
}

function renderLongTaskProgress(details: Record<string, unknown> | undefined, fallback: string, theme: Theme): string {
  const message = stringValue(details?.message) || firstLine(fallback) || "Pi Long Task is running...";
  const phase = stringValue(details?.phase);
  const toolName = stringValue(details?.toolName);
  const prefix = phase === "worker_tool" && toolName ? `worker ${toolName}` : phase || "progress";
  const currentTask = progressTaskDetails(details?.currentTask);
  if (!currentTask) {
    return `${theme.fg("accent", "●")} ${theme.fg("muted", prefix)} ${message}`;
  }

  const taskLabel = `TODO ${currentTask.taskId} — ${currentTask.title}`;
  const lines = [
    `${progressBubble(currentTask.status, theme)} ${theme.fg("muted", prefix)} ${theme.fg(progressTextColor(currentTask.status), taskLabel)}`,
  ];
  if (message && !message.includes(taskLabel)) {
    lines.push(`  ${theme.fg("dim", message)}`);
  }

  for (const subtask of progressSubtaskDetails(details?.subtasks)) {
    lines.push(
      `  ${progressBubble(subtask.status, theme)} ${theme.fg(progressTextColor(subtask.status), subtask.text)}`,
    );
  }

  return lines.join("\n");
}

function renderLongTaskSummary(details: CoordinatorToolRenderDetails, expanded: boolean, theme: Theme): string {
  const remainingCount = Math.max(0, details.totalTasks - details.completedTasks);
  const statusStyle = statusColor(details.status);
  const icon = details.status === "done" ? "✓" : details.status === "failed" ? "✗" : "!";
  const commitCount = (details.commits ?? []).filter((commit) => commit.hash).length;
  const summary = [
    `${theme.fg(statusStyle, icon)} ${theme.fg("toolTitle", theme.bold("Pi Long Task"))} ${theme.fg(statusStyle, details.status)}`,
    theme.fg("muted", `${details.completedTasks}/${details.totalTasks} tasks`),
    details.failedTasks ? theme.fg("error", `${details.failedTasks} failed`) : undefined,
    details.blockedTasks ? theme.fg("warning", `${details.blockedTasks} blocked`) : undefined,
    remainingCount ? theme.fg("muted", `${remainingCount} remaining`) : undefined,
    commitCount ? theme.fg("success", `${commitCount} commit${commitCount === 1 ? "" : "s"}`) : undefined,
    details.workerCostTotal ? theme.fg("muted", `worker ${formatCost(details.workerCostTotal)}`) : undefined,
  ].filter(Boolean);

  if (!expanded) {
    return summary.join(" — ");
  }

  const lines = [summary.join(" — "), theme.fg("muted", details.summary)];
  lines.push(theme.fg("dim", `Result: ${details.resultPath ?? details.taskResultPath ?? "unknown"}`));
  lines.push(theme.fg("dim", `TODO: ${details.todoPath}`));

  const commits = details.commits ?? [];
  if (commits.length > 0) {
    lines.push(theme.fg("muted", "Commits:"));
    for (const commit of commits) {
      const text = commit.hash
        ? `- TODO ${commit.taskId}: ${commit.hash}`
        : `- TODO ${commit.taskId}: commit error: ${commit.error ?? "unknown"}`;
      lines.push(theme.fg(commit.hash ? "success" : "error", text));
    }
  }

  const remaining = details.remainingTasks ?? [];
  if (remaining.length > 0) {
    lines.push(theme.fg("muted", "Remaining:"));
    for (const task of remaining) {
      lines.push(theme.fg("dim", `- TODO ${task.taskId} — ${task.title} (${task.status})`));
    }
  }

  if (details.error) {
    lines.push(theme.fg("error", `Error: ${details.error}`));
  }

  return lines.join("\n");
}

function taskProgressModel(value: unknown): TaskProgressModel | undefined {
  const record = recordOrUndefined(value);
  if (!record || !Array.isArray(record.tasks)) {
    return undefined;
  }
  return value as TaskProgressModel;
}

function progressTaskDetails(value: unknown): ProgressTaskRenderDetails | undefined {
  const record = recordOrUndefined(value);
  const taskId = stringValue(record?.taskId);
  const title = stringValue(record?.title);
  const status = progressItemStatus(record?.status);
  if (!taskId || !title || !status) {
    return undefined;
  }
  return { taskId, title, status };
}

function progressSubtaskDetails(value: unknown): ProgressSubtaskRenderDetails[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = recordOrUndefined(item);
    const text = stringValue(record?.text);
    const status = progressItemStatus(record?.status);
    if (!text || !status) {
      return [];
    }
    return [{ text, status }];
  });
}

function progressItemStatus(value: unknown): ProgressItemStatus | undefined {
  return value === "empty" || value === "in_progress" || value === "done" || value === "failed" || value === "blocked"
    ? value
    : undefined;
}

function progressBubble(status: ProgressItemStatus, theme: Theme): string {
  switch (status) {
    case "empty":
      return theme.fg("dim", "○");
    case "failed":
      return theme.fg("error", "✗");
    case "blocked":
      return theme.fg("warning", "!");
    default:
      return theme.fg(progressTextColor(status), "●");
  }
}

function progressTextColor(status: ProgressItemStatus): "success" | "warning" | "dim" | "error" {
  if (status === "done") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "in_progress" || status === "blocked") {
    return "warning";
  }
  return "dim";
}

function longTaskDetails(details: Record<string, unknown> | undefined): CoordinatorToolRenderDetails | undefined {
  if (!details) {
    return undefined;
  }

  const status = stringValue(details.status);
  const totalTasks = numberValue(details.totalTasks);
  const completedTasks = numberValue(details.completedTasks);
  const failedTasks = numberValue(details.failedTasks);
  const blockedTasks = numberValue(details.blockedTasks);
  const todoPath = stringValue(details.todoPath);
  const summary = stringValue(details.summary);
  if (
    !isCoordinatorStatus(status) ||
    totalTasks === undefined ||
    completedTasks === undefined ||
    !todoPath ||
    !summary
  ) {
    return undefined;
  }

  return {
    status,
    summary,
    totalTasks,
    completedTasks,
    failedTasks: failedTasks ?? 0,
    blockedTasks: blockedTasks ?? 0,
    todoPath,
    resultPath: stringValue(details.resultPath),
    taskResultPath: stringValue(details.taskResultPath),
    runId: stringValue(details.runId),
    commits: commitSummaries(details.commits),
    remainingTasks: remainingTaskSummaries(details.remainingTasks),
    taskProgress: taskProgressModel(details.taskProgress),
    workerCostTotal: nonNegativeNumberValue(details.workerCostTotal),
    error: stringValue(details.error),
  };
}

function commitSummaries(value: unknown): CoordinatorCommitSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = recordOrUndefined(item);
    const taskId = stringValue(record?.taskId);
    if (!taskId) {
      return [];
    }
    return [
      {
        taskId,
        hash: stringValue(record?.hash),
        error: stringValue(record?.error),
      },
    ];
  });
}

function remainingTaskSummaries(value: unknown): CoordinatorRemainingTask[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = recordOrUndefined(item);
    const taskId = stringValue(record?.taskId);
    const title = stringValue(record?.title);
    const status = stringValue(record?.status);
    if (!taskId || !title || !status) {
      return [];
    }
    return [{ taskId, title, status }];
  });
}

function statusColor(status: CoordinatorStatus): "success" | "warning" | "error" {
  if (status === "done") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  return "warning";
}

function isCoordinatorStatus(value: string): value is CoordinatorStatus {
  return value === "done" || value === "partial" || value === "blocked" || value === "failed";
}

function contentText(result: AgentToolResult<unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((item) => {
      const record = recordOrUndefined(item);
      return record?.type === "text" ? stringValue(record.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncatePlain(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
