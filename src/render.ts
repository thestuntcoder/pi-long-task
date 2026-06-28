import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type { GoalLoopState, GoalLoopStatus } from "./goal_loop.ts";
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
  goal?: string;
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

export function renderLongTaskToolCall(
  args: { inputText?: string; commit?: boolean; goal?: string },
  theme: Theme,
): Text {
  const commit = args.commit ? theme.fg("warning", "commit:on") : theme.fg("dim", "commit:off");
  const input = oneLine(args.inputText ?? "");
  const goal = oneLine(args.goal ?? "");
  const goalPreview = goal ? ` ${theme.fg("muted", `goal:${quote(truncatePlain(goal, 48))}`)}` : "";
  const preview = input ? ` ${theme.fg("muted", quote(truncatePlain(input, 96)))}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("pi_long_task"))} ${commit}${goalPreview}${preview}`, 0, 0);
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

export interface GoalLoopResultForRendering {
  state: GoalLoopState;
  resultPath: string;
  workerCostTotal: number;
  reviewerCostTotal: number;
  totalCost: number;
}

export interface GoalTaskToolRenderDetails {
  goalRunId: string;
  goal: string;
  status: GoalLoopStatus;
  currentIteration: number;
  totalIterations: number;
  minIterations: number;
  maxIterations: number;
  resultPath: string;
  statePath?: string;
  tracePath?: string;
  workerCostTotal?: number;
  reviewerCostTotal?: number;
  totalCost?: number;
  completionReason?: string;
  latestReviewerDecision?: string;
  remainingWork?: string[];
  error?: string;
}

export function formatGoalLoopResultMessage(result: GoalLoopResultForRendering): string {
  const state = result.state;
  const lines = [
    `Pi Goal Task: ${state.status}`,
    `Goal: ${state.goal}`,
    `Iterations: ${state.iterations.length}/${state.limits.maxIterations}`,
    `Minimum iterations: ${state.limits.minIterations}`,
    `Result file: ${result.resultPath}`,
    `State file: ${state.goalRunDir}/GOAL_STATE.json`,
  ];
  if (state.completion?.reason) {
    lines.push(`Outcome: ${state.completion.reason}`);
  }
  if (result.totalCost > 0) {
    lines.push(`Worker/reviewer spend: ${formatCost(result.totalCost)}`);
  }
  const latestReview = [...state.iterations].reverse().find((iteration) => iteration.reviewerResult)?.reviewerResult;
  if (latestReview) {
    lines.push(`Latest review: ${latestReview.decision} — ${latestReview.summary}`);
    if (latestReview.remainingWork.length > 0) {
      lines.push("Remaining work:", ...latestReview.remainingWork.map((item) => `- ${item}`));
    }
  }
  return lines.join("\n");
}

export function goalTaskDetailsFromResult(result: GoalLoopResultForRendering): GoalTaskToolRenderDetails {
  const latestReview = [...result.state.iterations]
    .reverse()
    .find((iteration) => iteration.reviewerResult)?.reviewerResult;
  return {
    goalRunId: result.state.goalRunId,
    goal: result.state.goal,
    status: result.state.status,
    currentIteration: result.state.currentIteration,
    totalIterations: result.state.iterations.length,
    minIterations: result.state.limits.minIterations,
    maxIterations: result.state.limits.maxIterations,
    resultPath: result.resultPath,
    statePath: `${result.state.goalRunDir}/GOAL_STATE.json`,
    tracePath: `${result.state.goalRunDir}/GOAL_TRACE.jsonl`,
    workerCostTotal: result.workerCostTotal,
    reviewerCostTotal: result.reviewerCostTotal,
    totalCost: result.totalCost,
    completionReason: result.state.completion?.reason,
    latestReviewerDecision: latestReview?.decision,
    remainingWork: latestReview?.remainingWork,
  };
}

export function renderGoalTaskToolCall(
  args: {
    goal?: string;
    commit?: boolean;
    minIterations?: number;
    maxIterations?: number;
    timeoutMs?: number;
    reviewerTimeoutMs?: number;
  },
  theme: Theme,
): Text {
  const commit = (args.commit ?? true) ? theme.fg("warning", "commit:on") : theme.fg("dim", "commit:off");
  const goal = oneLine(args.goal ?? "");
  const limits = [
    args.minIterations ? `min:${args.minIterations}` : undefined,
    args.maxIterations ? `max:${args.maxIterations}` : undefined,
    args.timeoutMs ? `timeout:${args.timeoutMs}ms` : undefined,
    args.reviewerTimeoutMs ? `review:${args.reviewerTimeoutMs}ms` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const limitPreview = limits ? ` ${theme.fg("muted", limits)}` : "";
  const goalPreview = goal ? ` ${theme.fg("muted", quote(truncatePlain(goal, 80)))}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("pi_goal_task"))} ${commit}${limitPreview}${goalPreview}`, 0, 0);
}

export function renderGoalTaskToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = recordOrUndefined(result.details);
  if (options.isPartial) {
    return new Text(renderGoalTaskProgress(details, contentText(result), theme), 0, 0);
  }

  const finalDetails = goalTaskDetails(details);
  if (!finalDetails) {
    return new Text(contentText(result), 0, 0);
  }

  return new Text(renderGoalTaskSummary(finalDetails, options.expanded, theme), 0, 0);
}

function renderGoalTaskProgress(details: Record<string, unknown> | undefined, fallback: string, theme: Theme): string {
  const message = stringValue(details?.message) || firstLine(fallback) || "Pi Goal Task is running...";
  const phase = stringValue(details?.phase);
  const iteration = numberValue(details?.iteration) ?? numberValue(details?.currentIteration);
  const minIterations = numberValue(details?.minIterations);
  const maxIterations = numberValue(details?.maxIterations);
  const status = stringValue(details?.status) || "running";
  const cost = numberValue(details?.totalCost);
  const meta = [
    iteration ? `iteration ${iteration}${maxIterations ? `/${maxIterations}` : ""}` : undefined,
    minIterations && iteration && iteration < minIterations ? `min:${minIterations}` : undefined,
    status,
    cost && cost > 0 ? formatCost(cost) : undefined,
  ]
    .filter(Boolean)
    .join(` ${theme.fg("dim", "·")} `);
  const icon = phase === "complete" ? (status === "done" ? "✓" : "!") : "+";
  const color = phase === "complete" ? statusColor(status) : "warning";
  return `${theme.fg(color, icon)} ${theme.fg(color, "Pi Goal Task")}${meta ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", meta)}` : ""}\n  ${theme.fg("dim", message)}`;
}

function renderGoalTaskSummary(details: GoalTaskToolRenderDetails, expanded: boolean, theme: Theme): string {
  const statusStyle = statusColor(details.status);
  const icon =
    details.status === "done" ? "✓" : details.status === "failed" ? "✗" : details.status === "cancelled" ? "×" : "!";
  const summary = [
    `${theme.fg(statusStyle, icon)} ${theme.fg("toolTitle", theme.bold("Pi Goal Task"))} ${theme.fg(statusStyle, details.status)}`,
    theme.fg("muted", `${details.totalIterations}/${details.maxIterations} iterations`),
    details.totalIterations < details.minIterations ? theme.fg("muted", `min:${details.minIterations}`) : undefined,
    details.latestReviewerDecision ? theme.fg("muted", `review:${details.latestReviewerDecision}`) : undefined,
    details.totalCost ? theme.fg("muted", `spend ${formatCost(details.totalCost)}`) : undefined,
  ].filter(Boolean);

  if (!expanded) {
    return summary.join(" — ");
  }

  const lines = [summary.join(" — "), theme.fg("muted", details.goal)];
  if (details.completionReason) {
    lines.push(theme.fg("dim", `Outcome: ${details.completionReason}`));
  }
  lines.push(theme.fg("dim", `Result: ${details.resultPath}`));
  if (details.statePath) {
    lines.push(theme.fg("dim", `State: ${details.statePath}`));
  }
  if (details.tracePath) {
    lines.push(theme.fg("dim", `Trace: ${details.tracePath}`));
  }
  const remaining = details.remainingWork ?? [];
  if (remaining.length > 0) {
    lines.push(theme.fg("muted", "Remaining work:"), ...remaining.map((item) => theme.fg("dim", `- ${item}`)));
  }
  if (details.error) {
    lines.push(theme.fg("error", `Error: ${details.error}`));
  }
  return lines.join("\n");
}

function goalTaskDetails(details: Record<string, unknown> | undefined): GoalTaskToolRenderDetails | undefined {
  if (!details) {
    return undefined;
  }
  const goalRunId = stringValue(details.goalRunId);
  const goal = stringValue(details.goal);
  const status = goalLoopStatus(details.status);
  const resultPath = stringValue(details.resultPath);
  if (!goalRunId || !goal || !status || !resultPath) {
    return undefined;
  }
  return {
    goalRunId,
    goal,
    status,
    currentIteration: numberValue(details.currentIteration) ?? 0,
    totalIterations: numberValue(details.totalIterations) ?? 0,
    minIterations: numberValue(details.minIterations) ?? 0,
    maxIterations: numberValue(details.maxIterations) ?? 0,
    resultPath,
    statePath: stringValue(details.statePath),
    tracePath: stringValue(details.tracePath),
    workerCostTotal: numberValue(details.workerCostTotal),
    reviewerCostTotal: numberValue(details.reviewerCostTotal),
    totalCost: numberValue(details.totalCost),
    completionReason: stringValue(details.completionReason),
    latestReviewerDecision: stringValue(details.latestReviewerDecision),
    remainingWork: stringArray(details.remainingWork),
    error: stringValue(details.error),
  };
}

function renderLongTaskProgress(details: Record<string, unknown> | undefined, fallback: string, theme: Theme): string {
  const message = stringValue(details?.message) || firstLine(fallback) || "Pi Long Task is running...";
  const phase = stringValue(details?.phase);
  const toolName = stringValue(details?.toolName);
  const prefix = phase === "worker_tool" && toolName ? `worker ${toolName}` : phase || "progress";
  const currentTask = progressTaskDetails(details?.currentTask);
  const progress = taskProgressModel(details?.taskProgress);

  if (!currentTask) {
    return `${theme.fg("warning", "+")} ${theme.fg("warning", `${progressPhaseLabel(phase)}:`)} ${message}`;
  }

  const taskLabel = `TODO ${currentTask.taskId} — ${currentTask.title}`;
  const status = progressItemStatusDetails(currentTask.status);
  const activitySuffix =
    phase === "worker_tool" && toolName ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `worker ${toolName}`)}` : "";
  const attempt = numberValue(details?.attempt);
  const attemptSuffix =
    attempt && attempt > 1 ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `attempt ${attempt}`)}` : "";
  const lines = [
    `${theme.fg("warning", "+")} ${theme.fg("warning", `${progressPhaseLabel(phase)}:`)} ${theme.fg(
      status.textColor,
      taskLabel,
    )}${activitySuffix}${attemptSuffix}`,
  ];

  if (progress) {
    lines.push(renderTaskProgressStrip(progress, theme));
  }

  if (message && !message.includes(taskLabel)) {
    lines.push(`  ${theme.fg("dim", "⚙")} ${theme.fg("dim", `${prefix} · ${message}`)}`);
  }

  for (const subtask of progressSubtaskDetails(details?.subtasks)) {
    lines.push(renderProgressSubtaskLine(subtask, theme));
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

function progressPhaseLabel(phase: string): string {
  switch (phase) {
    case "planning":
    case "planned":
      return "Thought";
    case "task_start":
    case "worker_tool":
      return "Build";
    case "task_done":
      return "Done";
    case "task_failed":
      return "Failed";
    case "task_blocked":
      return "Blocked";
    case "complete":
      return "Complete";
    default:
      return "Progress";
  }
}

function renderTaskProgressStrip(progress: TaskProgressModel, theme: Theme): string {
  const summary = progress.summary;
  const track = taskProgressTrack(progress, theme);
  const counts = [
    theme.fg("muted", `${summary.completedTasks}/${summary.totalTasks}`),
    theme.fg("muted", `${summary.completedPercent}%`),
    summary.failedTasks ? theme.fg("error", `${summary.failedTasks} failed`) : undefined,
    summary.blockedTasks ? theme.fg("warning", `${summary.blockedTasks} blocked`) : undefined,
    summary.currentTasks ? theme.fg("warning", `${summary.currentTasks} active`) : undefined,
    summary.pendingTasks ? theme.fg("dim", `${summary.pendingTasks} queued`) : undefined,
  ]
    .filter(Boolean)
    .join(` ${theme.fg("dim", "·")} `);
  return `  ${track} ${counts}`;
}

function taskProgressTrack(progress: TaskProgressModel, theme: Theme): string {
  const taskIndexes = focusedTaskIndexes(progress);
  const first = taskIndexes[0] ?? 0;
  const last = taskIndexes[taskIndexes.length - 1] ?? -1;
  const prefix = first > 0 ? theme.fg("dim", "… ") : "";
  const suffix = last >= 0 && last < progress.tasks.length - 1 ? theme.fg("dim", " …") : "";
  return `${prefix}${taskIndexes.map((index) => taskProgressTaskGlyph(progress.tasks[index], theme)).join(" ")}${suffix}`;
}

function focusedTaskIndexes(progress: TaskProgressModel): number[] {
  const total = progress.tasks.length;
  if (total <= 0) {
    return [];
  }
  const limit = Math.min(total, 8);
  const focus = Math.max(0, Math.min(total - 1, progress.currentIndex ?? progress.nextIndex ?? 0));
  const start = Math.max(0, Math.min(total - limit, focus - Math.floor(limit / 2)));
  return Array.from({ length: limit }, (_value, index) => start + index);
}

function taskProgressTaskGlyph(task: TaskProgressModel["tasks"][number] | undefined, theme: Theme): string {
  if (!task) {
    return "";
  }
  const details = taskStatusDetails(task.status);
  return theme.fg(details.color, details.icon);
}

function renderProgressSubtaskLine(subtask: ProgressSubtaskRenderDetails, theme: Theme): string {
  const details = progressItemStatusDetails(subtask.status);
  return `  ${theme.fg(details.color, details.icon)} ${theme.fg(details.textColor, `${details.label} · ${subtask.text}`)}`;
}

function progressItemStatus(value: unknown): ProgressItemStatus | undefined {
  return value === "empty" || value === "in_progress" || value === "done" || value === "failed" || value === "blocked"
    ? value
    : undefined;
}

function taskStatusDetails(status: TaskProgressModel["tasks"][number]["status"]): {
  icon: string;
  label: string;
  color: "accent" | "success" | "warning" | "dim" | "error";
  textColor: "accent" | "text" | "success" | "warning" | "dim" | "error";
} {
  switch (status) {
    case "completed":
      return { icon: "✓", label: "done", color: "success", textColor: "dim" };
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

function progressItemStatusDetails(status: ProgressItemStatus): {
  icon: string;
  label: string;
  color: "accent" | "success" | "warning" | "dim" | "error";
  textColor: "accent" | "success" | "warning" | "dim" | "error";
} {
  switch (status) {
    case "done":
      return { icon: "✓", label: "done", color: "success", textColor: "dim" };
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

function statusColor(status: CoordinatorStatus | GoalLoopStatus | string): "success" | "warning" | "error" {
  if (status === "done") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  return "warning";
}

function isCoordinatorStatus(value: string): value is CoordinatorStatus {
  return value === "done" || value === "partial" || value === "blocked" || value === "failed";
}

function goalLoopStatus(value: unknown): GoalLoopStatus | undefined {
  return value === "running" ||
    value === "done" ||
    value === "partial" ||
    value === "blocked" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
