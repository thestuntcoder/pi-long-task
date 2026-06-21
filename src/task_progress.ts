import type { Task, TaskStatusItem } from "./todo_parser.ts";

export const TASK_PROGRESS_STATUS_VALUES = ["pending", "current", "completed", "failed", "blocked"] as const;
export type TaskProgressStatus = (typeof TASK_PROGRESS_STATUS_VALUES)[number];

export const TASK_PROGRESS_POSITION_VALUES = ["past", "current", "future"] as const;
export type TaskProgressPosition = (typeof TASK_PROGRESS_POSITION_VALUES)[number];

export interface TaskProgressAttempt {
  taskId: string;
  attempt?: number;
  reportedStatus?: string;
  done?: boolean;
}

export type TaskProgressTaskStatusItem = TaskStatusItem;

export interface TaskProgressTask {
  taskId: string;
  title: string;
  status: TaskProgressStatus;
  position: TaskProgressPosition;
  done: boolean;
  statusItems: TaskProgressTaskStatusItem[];
  attempts: number;
  lastReportedStatus?: string;
}

export interface TaskProgressSummary {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  pendingTasks: number;
  currentTasks: number;
  attemptedTasks: number;
  completionRatio: number;
  completedPercent: number;
}

export interface TaskProgressModel {
  tasks: TaskProgressTask[];
  summary: TaskProgressSummary;
  currentTaskId?: string;
  currentIndex?: number;
  currentTask?: TaskProgressTask;
  nextTaskId?: string;
  nextIndex?: number;
  nextTask?: TaskProgressTask;
}

export interface BuildTaskProgressModelOptions {
  tasks: readonly Task[];
  attempts?: readonly TaskProgressAttempt[];
  currentTaskId?: string;
  currentTaskStatus?: TaskProgressStatus;
}

export function buildTaskProgressModel(options: BuildTaskProgressModelOptions): TaskProgressModel {
  const attempts = options.attempts ?? [];
  const attemptStats = attemptsByTask(attempts);
  const activeIndex = activeTaskIndex(options.tasks, options.currentTaskId);

  const progressTasks = options.tasks.map((task, index) => {
    const stats = attemptStats.get(task.taskId);
    const isActive = index === activeIndex;
    const status = taskProgressStatus(task, stats?.lastAttempt, isActive, options.currentTaskStatus);

    const progressTask: TaskProgressTask = {
      taskId: task.taskId,
      title: task.title,
      status,
      position: taskProgressPosition(index, activeIndex, status),
      done: status === "completed",
      statusItems: task.statusItems.map((item) => ({ ...item })),
      attempts: stats?.attempts ?? 0,
    };
    if (stats?.lastAttempt.reportedStatus) {
      progressTask.lastReportedStatus = stats.lastAttempt.reportedStatus;
    }
    return progressTask;
  });

  const currentIndex = progressTasks.findIndex((task) => task.position === "current");
  const nextIndex = progressTasks.findIndex((task) => task.status === "pending");
  const summary = taskProgressSummary(progressTasks, attempts.length);

  const model: TaskProgressModel = {
    tasks: progressTasks,
    summary,
  };
  if (currentIndex >= 0) {
    model.currentIndex = currentIndex;
    model.currentTask = progressTasks[currentIndex];
    model.currentTaskId = progressTasks[currentIndex].taskId;
  }
  if (nextIndex >= 0) {
    model.nextIndex = nextIndex;
    model.nextTask = progressTasks[nextIndex];
    model.nextTaskId = progressTasks[nextIndex].taskId;
  }
  return model;
}

interface TaskAttemptStats {
  attempts: number;
  lastAttempt: TaskProgressAttempt;
}

function attemptsByTask(attempts: readonly TaskProgressAttempt[]): Map<string, TaskAttemptStats> {
  const stats = new Map<string, TaskAttemptStats>();
  for (const attempt of attempts) {
    const existing = stats.get(attempt.taskId);
    stats.set(attempt.taskId, {
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttempt: attempt,
    });
  }
  return stats;
}

function activeTaskIndex(tasks: readonly Task[], currentTaskId: string | undefined): number {
  if (!currentTaskId) {
    return -1;
  }
  return tasks.findIndex((task) => task.taskId === currentTaskId);
}

function taskProgressStatus(
  task: Task,
  lastAttempt: TaskProgressAttempt | undefined,
  isActive: boolean,
  currentTaskStatus: TaskProgressStatus | undefined,
): TaskProgressStatus {
  if (task.done || lastAttempt?.done || (isActive && currentTaskStatus === "completed")) {
    return "completed";
  }
  if (isActive) {
    if (currentTaskStatus === "failed" || currentTaskStatus === "blocked") {
      return currentTaskStatus;
    }
    return "current";
  }
  if (lastAttempt?.reportedStatus === "blocked") {
    return "blocked";
  }
  if (lastAttempt) {
    return "failed";
  }
  return "pending";
}

function taskProgressPosition(index: number, activeIndex: number, status: TaskProgressStatus): TaskProgressPosition {
  if (activeIndex >= 0) {
    if (index < activeIndex) {
      return "past";
    }
    if (index === activeIndex) {
      return "current";
    }
    return "future";
  }

  return status === "pending" || status === "current" ? "future" : "past";
}

function taskProgressSummary(tasks: readonly TaskProgressTask[], attemptedTasks: number): TaskProgressSummary {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const blockedTasks = tasks.filter((task) => task.status === "blocked").length;
  const pendingTasks = tasks.filter((task) => task.status === "pending").length;
  const currentTasks = tasks.filter((task) => task.status === "current").length;
  const completionRatio = totalTasks === 0 ? 1 : completedTasks / totalTasks;

  return {
    totalTasks,
    completedTasks,
    failedTasks,
    blockedTasks,
    pendingTasks,
    currentTasks,
    attemptedTasks,
    completionRatio,
    completedPercent: Math.round(completionRatio * 100),
  };
}
