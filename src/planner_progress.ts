import type { PlannerBudget, PlannerComplexitySignal } from "./planner_config.ts";

export type PlannerProgressState = "started" | "active" | "grace";

/**
 * One user-facing planner timing update. Millisecond fields remain available to
 * integrations while `message` consistently uses friendly duration wording.
 */
export interface PlannerProgressEvent {
  state: PlannerProgressState;
  message: string;
  budgetMs: number;
  gracePeriodMs: number;
  elapsedMs: number;
  remainingMs: number;
  graceRemainingMs?: number;
  budget: Readonly<PlannerBudget>;
}

export type PlannerProgressHandler = (event: Readonly<PlannerProgressEvent>) => void;

/** Formats a duration for people rather than exposing raw millisecond counts. */
export function formatFriendlyDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  if (milliseconds > 0 && milliseconds < 1_000) {
    return "less than 1 second";
  }

  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) {
    return plural(totalSeconds, "second");
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return joinDurationParts(plural(totalMinutes, "minute"), seconds > 0 ? plural(seconds, "second") : undefined);
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return joinDurationParts(plural(totalHours, "hour"), minutes > 0 ? plural(minutes, "minute") : undefined);
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return joinDurationParts(plural(days, "day"), hours > 0 ? plural(hours, "hour") : undefined);
}

export function createPlannerStartedProgress(
  budget: Readonly<PlannerBudget>,
  gracePeriodMs: number,
): PlannerProgressEvent {
  const budgetText = formatFriendlyDuration(budget.timeoutMs);
  const sourceText = budget.source === "explicit" ? " (explicitly configured)" : "";
  const adaptiveText = adaptiveExtensionExplanation(budget);
  const graceText =
    gracePeriodMs > 0
      ? ` A ${formatFriendlyDurationModifier(gracePeriodMs)} graceful-shutdown period is available afterward.`
      : " No graceful-shutdown period is configured.";

  return {
    state: "started",
    message: `Creating TODO plan. Effective planning budget: ${budgetText}${sourceText}.${adaptiveText}${graceText}`,
    budgetMs: budget.timeoutMs,
    gracePeriodMs,
    elapsedMs: 0,
    remainingMs: budget.timeoutMs,
    budget,
  };
}

export function createPlannerActiveProgress(
  budget: Readonly<PlannerBudget>,
  gracePeriodMs: number,
  elapsedMs: number,
): PlannerProgressEvent {
  const elapsed = clamp(elapsedMs, 0, budget.timeoutMs);
  const remaining = Math.max(0, budget.timeoutMs - elapsed);
  return {
    state: "active",
    message: `Still planning: ${formatFriendlyDuration(elapsed)} elapsed; about ${formatFriendlyDuration(remaining)} remaining in the ${formatFriendlyDuration(budget.timeoutMs)} budget.`,
    budgetMs: budget.timeoutMs,
    gracePeriodMs,
    elapsedMs: elapsed,
    remainingMs: remaining,
    budget,
  };
}

export function createPlannerGraceProgress(
  budget: Readonly<PlannerBudget>,
  gracePeriodMs: number,
): PlannerProgressEvent {
  const grace = Math.max(0, gracePeriodMs);
  return {
    state: "grace",
    message: `Planning budget reached after ${formatFriendlyDuration(budget.timeoutMs)}; entering a ${formatFriendlyDurationModifier(grace)} graceful-shutdown period to finish a valid plan.`,
    budgetMs: budget.timeoutMs,
    gracePeriodMs: grace,
    elapsedMs: budget.timeoutMs,
    remainingMs: 0,
    graceRemainingMs: grace,
    budget,
  };
}

/** Three bounded checkpoints provide useful timing without per-second noise. */
export function plannerProgressCheckpoints(budgetMs: number): number[] {
  const budget = Math.max(0, Math.floor(budgetMs));
  if (budget <= 1) {
    return [];
  }
  return [...new Set([0.25, 0.5, 0.75].map((fraction) => Math.max(1, Math.floor(budget * fraction))))].filter(
    (checkpoint) => checkpoint < budget,
  );
}

function formatFriendlyDurationModifier(durationMs: number): string {
  return formatFriendlyDuration(durationMs).replace(
    /(\d[\d,]*) (seconds?|minutes?|hours?|days?)/g,
    (_match, value: string, unit: string) => `${value}-${unit.replace(/s$/, "")}`,
  );
}

function adaptiveExtensionExplanation(budget: Readonly<PlannerBudget>): string {
  if (!budget.extensionApplied || budget.extensionMs <= 0 || !budget.trigger) {
    return "";
  }
  return ` Adaptive extension: ${formatFriendlyDuration(budget.extensionMs)} because the request includes ${complexitySignalText(budget.trigger)}.`;
}

function complexitySignalText(signal: Readonly<PlannerComplexitySignal>): string {
  switch (signal.kind) {
    case "separately_planned_tasks":
      return `${signal.itemCount} separately planned ${signal.itemCount === 1 ? "task" : "tasks"}`;
    case "explicit_item_count":
      return `an explicit count of ${signal.itemCount} ${signal.itemCount === 1 ? "deliverable" : "deliverables"}`;
    case "enumerated_deliverables":
      return `${signal.itemCount} enumerated ${signal.itemCount === 1 ? "deliverable" : "deliverables"}`;
  }
}

function plural(value: number, unit: string): string {
  return `${value.toLocaleString("en-US")} ${unit}${value === 1 ? "" : "s"}`;
}

function joinDurationParts(first: string, second: string | undefined): string {
  return second ? `${first} ${second}` : first;
}

function clamp(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(finite)));
}
