export const MAX_PLANNER_DURATION_MS = 2_147_483_647;

/** Thinking levels accepted by the supported Pi SDK, in increasing reasoning-budget order. */
export const SUPPORTED_PLANNER_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PlannerThinkingLevel = (typeof SUPPORTED_PLANNER_THINKING_LEVELS)[number];
/**
 * Planner-only quality/latency balance. `high` retains enough reasoning budget
 * for dependency-aware complex plans without imposing `xhigh` latency on every
 * ordinary request. Explicit caller values remain authoritative.
 */
export const DEFAULT_PLANNER_THINKING_LEVEL: PlannerThinkingLevel = "high";

/** Normal planning budget used for requests that do not contain a scale signal. */
export const DEFAULT_PLANNER_TIMEOUT_MS = 300_000;
/** Adaptive planning never reduces the normal five-minute budget. */
export const MIN_ADAPTIVE_PLANNER_TIMEOUT_MS = DEFAULT_PLANNER_TIMEOUT_MS;
/** Adaptive planning is capped at fifteen minutes, even for very large requests. */
export const MAX_ADAPTIVE_PLANNER_TIMEOUT_MS = 900_000;
/** The normal budget includes up to four requested deliverables. */
export const PLANNER_ITEMS_INCLUDED_IN_BASE_BUDGET = 4;
/** Every additional detected deliverable adds thirty seconds until the cap. */
export const PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS = 30_000;

export type PlannerComplexitySignalKind =
  | "explicit_item_count"
  | "enumerated_deliverables"
  | "separately_planned_tasks";

export interface PlannerComplexitySignal {
  kind: PlannerComplexitySignalKind;
  itemCount: number;
}

export type PlannerBudgetSource = "explicit" | "default" | "adaptive";

/**
 * Complete, machine-readable record of how a planner deadline was selected.
 * `trigger` is present only when a deterministic complexity signal actually
 * extended the normal budget.
 */
export interface PlannerBudget {
  timeoutMs: number;
  baseTimeoutMs: number;
  minimumTimeoutMs: number;
  maximumTimeoutMs: number;
  extensionApplied: boolean;
  extensionMs: number;
  source: PlannerBudgetSource;
  signals: readonly PlannerComplexitySignal[];
  trigger?: PlannerComplexitySignal;
}

export interface ResolvePlannerBudgetOptions {
  inputText: string;
  /** Structured or natural-language timeout configuration. It always wins exactly. */
  explicitTimeoutMs?: number;
  defaultTimeoutMs?: number;
}

const EXPLICIT_ITEM_COUNT_RE =
  /\b(\d{1,6})\s+(?:(?:separate(?:ly)?|individual(?:ly)?|distinct|independent(?:ly)?)\s+(?:planned\s+)?)?(?:(?:user|job|work)\s+)?(?:stories|tasks|todos?|deliverables?|items?|work\s+items?|features?|components?|pages?|endpoints?|tests?|scenarios?|requirements?)\b/gi;
const ENUMERATED_DELIVERABLE_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,6}[.)]\s+)\S.*$/gm;
const SEPARATE_PLANNING_RE =
  /\b(?:separately|individually|independently)\s+(?:plan(?:ned)?|scope(?:d)?|specif(?:y|ied)|assign(?:ed)?)\b|\b(?:plan|scope|specify)\s+(?:each|every)\b|\b(?:separate|individual|independent)\s+(?:plans?|tasks?|todos?|work\s+items?)\b/i;

/**
 * Detects only reproducible textual scale signals:
 *
 * 1. an integer directly attached to a deliverable noun (for example,
 *    "24 stories"),
 * 2. line-start bullet or numbered deliverables, and
 * 3. explicit language requiring those items to be planned separately.
 *
 * The detector intentionally does not estimate semantic difficulty or ask the
 * model to grade complexity. Signals are returned in stable priority order.
 */
export function detectPlannerComplexitySignals(inputText: string): PlannerComplexitySignal[] {
  const normalized = inputText.replace(/\r\n?/g, "\n");
  const explicitItemCount = maximumMatchedInteger(normalized, EXPLICIT_ITEM_COUNT_RE);
  const enumeratedItemCount = [...normalized.matchAll(ENUMERATED_DELIVERABLE_RE)].length;
  const signals: PlannerComplexitySignal[] = [];

  if (SEPARATE_PLANNING_RE.test(normalized)) {
    const separatelyPlannedCount = Math.max(explicitItemCount ?? 0, enumeratedItemCount);
    if (separatelyPlannedCount > 0) {
      signals.push({ kind: "separately_planned_tasks", itemCount: separatelyPlannedCount });
    }
  }
  if (explicitItemCount !== undefined) {
    signals.push({ kind: "explicit_item_count", itemCount: explicitItemCount });
  }
  if (enumeratedItemCount > 0) {
    signals.push({ kind: "enumerated_deliverables", itemCount: enumeratedItemCount });
  }

  return signals;
}

/**
 * Selects a deterministic planner deadline. The normal five-minute budget
 * covers four items; each additional item adds thirty seconds, capped at
 * fifteen minutes. Explicit timeout configuration bypasses both detection and
 * adaptive bounds and is returned unchanged after public duration validation.
 */
export function resolvePlannerBudget(options: ResolvePlannerBudgetOptions): PlannerBudget {
  const baseTimeoutMs = resolvePlannerTimeoutMs(options.defaultTimeoutMs, DEFAULT_PLANNER_TIMEOUT_MS);

  if (options.explicitTimeoutMs !== undefined) {
    const timeoutMs = resolvePlannerTimeoutMs(options.explicitTimeoutMs, baseTimeoutMs);
    return {
      timeoutMs,
      baseTimeoutMs,
      minimumTimeoutMs: MIN_ADAPTIVE_PLANNER_TIMEOUT_MS,
      maximumTimeoutMs: MAX_ADAPTIVE_PLANNER_TIMEOUT_MS,
      extensionApplied: false,
      extensionMs: 0,
      source: "explicit",
      signals: [],
    };
  }

  const signals = detectPlannerComplexitySignals(options.inputText);
  const trigger = strongestComplexitySignal(signals);
  const additionalItems = Math.max(0, (trigger?.itemCount ?? 0) - PLANNER_ITEMS_INCLUDED_IN_BASE_BUDGET);
  const requestedTimeoutMs = baseTimeoutMs + additionalItems * PLANNER_TIMEOUT_PER_ADDITIONAL_ITEM_MS;
  const timeoutMs = Math.min(
    MAX_ADAPTIVE_PLANNER_TIMEOUT_MS,
    Math.max(MIN_ADAPTIVE_PLANNER_TIMEOUT_MS, requestedTimeoutMs),
  );
  const extensionMs = Math.max(0, timeoutMs - baseTimeoutMs);
  const extensionApplied = extensionMs > 0;

  return {
    timeoutMs,
    baseTimeoutMs,
    minimumTimeoutMs: MIN_ADAPTIVE_PLANNER_TIMEOUT_MS,
    maximumTimeoutMs: MAX_ADAPTIVE_PLANNER_TIMEOUT_MS,
    extensionApplied,
    extensionMs,
    source: extensionApplied ? "adaptive" : "default",
    signals,
    ...(extensionApplied && trigger ? { trigger } : {}),
  };
}

export class PlannerDurationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerDurationConfigError";
  }
}

export function resolvePlannerTimeoutMs(value: number | undefined, fallback: number): number {
  return resolvePlannerDurationMs(value, fallback, "TODO planner timeout", false);
}

export function resolvePlannerGracefulShutdownMs(value: number | undefined, fallback: number): number {
  return resolvePlannerDurationMs(value, fallback, "TODO planner graceful-shutdown duration", true);
}

export function validatePlannerTimeoutMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : resolvePlannerTimeoutMs(value, value);
}

export function validatePlannerGracefulShutdownMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : resolvePlannerGracefulShutdownMs(value, value);
}

function maximumMatchedInteger(value: string, expression: RegExp): number | undefined {
  expression.lastIndex = 0;
  let maximum: number | undefined;
  for (const match of value.matchAll(expression)) {
    const count = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(count) && count > 0) {
      maximum = Math.max(maximum ?? 0, count);
    }
  }
  return maximum;
}

function strongestComplexitySignal(signals: readonly PlannerComplexitySignal[]): PlannerComplexitySignal | undefined {
  // Stable input order is also the tie-break priority: separate planning,
  // explicit counts, then plain enumeration.
  return signals.reduce<PlannerComplexitySignal | undefined>(
    (strongest, signal) => (!strongest || signal.itemCount > strongest.itemCount ? signal : strongest),
    undefined,
  );
}

function resolvePlannerDurationMs(
  value: number | undefined,
  fallback: number,
  label: string,
  allowZero: boolean,
): number {
  if (value === undefined) {
    return fallback;
  }

  const minimumDescription = allowZero ? "a non-negative" : "a positive";
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (!allowZero && value <= 0) ||
    (allowZero && value < 0) ||
    value > MAX_PLANNER_DURATION_MS
  ) {
    throw new PlannerDurationConfigError(
      `${label} must be ${minimumDescription} whole-millisecond duration no greater than about 24.9 days (${MAX_PLANNER_DURATION_MS} milliseconds); received ${String(value)}.`,
    );
  }

  return value;
}
