import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
  error?: string;
}

export interface CoordinatorToolRenderDetails extends CoordinatorResultForRendering {
  runId?: string;
}

export function formatCoordinatorResultMessage(result: CoordinatorResultForRendering): string {
  const resultPath = result.resultPath ?? result.taskResultPath ?? "unknown";
  const remaining = result.remainingTasks ?? [];
  const commits = result.commits ?? [];
  const remainingCount = Math.max(0, result.totalTasks - result.completedTasks);
  const lines = [
    `Pi TODO coordinator: ${result.status}`,
    `Tasks: ${result.completedTasks} completed, ${result.failedTasks} failed, ${result.blockedTasks} blocked, ${remainingCount} remaining (${result.totalTasks} total).`,
    `Result file: ${resultPath}`,
    `TODO file: ${result.todoPath}`,
  ];

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

export function renderCoordinatorToolCall(args: { inputText?: string; commit?: boolean }, theme: Theme): Text {
  const commit = args.commit ? theme.fg("warning", "commit:on") : theme.fg("dim", "commit:off");
  const input = oneLine(args.inputText ?? "");
  const preview = input ? ` ${theme.fg("muted", quote(truncatePlain(input, 96)))}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("pi_todo_coordinator"))} ${commit}${preview}`, 0, 0);
}

export function renderCoordinatorToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const details = recordOrUndefined(result.details);
  if (options.isPartial) {
    return new Text(renderCoordinatorProgress(details, contentText(result), theme), 0, 0);
  }

  const finalDetails = coordinatorDetails(details);
  if (!finalDetails) {
    return new Text(contentText(result), 0, 0);
  }

  return new Text(renderCoordinatorSummary(finalDetails, options.expanded, theme), 0, 0);
}

function renderCoordinatorProgress(
  details: Record<string, unknown> | undefined,
  fallback: string,
  theme: Theme,
): string {
  const message = stringValue(details?.message) || firstLine(fallback) || "Coordinator is running...";
  const phase = stringValue(details?.phase);
  const toolName = stringValue(details?.toolName);
  const prefix = phase === "worker_tool" && toolName ? `worker ${toolName}` : phase || "progress";
  return `${theme.fg("accent", "●")} ${theme.fg("muted", prefix)} ${message}`;
}

function renderCoordinatorSummary(details: CoordinatorToolRenderDetails, expanded: boolean, theme: Theme): string {
  const remainingCount = Math.max(0, details.totalTasks - details.completedTasks);
  const statusStyle = statusColor(details.status);
  const icon = details.status === "done" ? "✓" : details.status === "failed" ? "✗" : "!";
  const commitCount = (details.commits ?? []).filter((commit) => commit.hash).length;
  const summary = [
    `${theme.fg(statusStyle, icon)} ${theme.fg("toolTitle", theme.bold("Pi TODO coordinator"))} ${theme.fg(statusStyle, details.status)}`,
    theme.fg("muted", `${details.completedTasks}/${details.totalTasks} tasks`),
    details.failedTasks ? theme.fg("error", `${details.failedTasks} failed`) : undefined,
    details.blockedTasks ? theme.fg("warning", `${details.blockedTasks} blocked`) : undefined,
    remainingCount ? theme.fg("muted", `${remainingCount} remaining`) : undefined,
    commitCount ? theme.fg("success", `${commitCount} commit${commitCount === 1 ? "" : "s"}`) : undefined,
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

function coordinatorDetails(details: Record<string, unknown> | undefined): CoordinatorToolRenderDetails | undefined {
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

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
