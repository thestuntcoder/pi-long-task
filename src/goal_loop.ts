import path from "node:path";

import type { CoordinatorStatus } from "./types.ts";

export const GOAL_LOOP_STATE_SCHEMA_VERSION = 1;

export const DEFAULT_GOAL_LOOP_LIMITS = {
  minIterations: 1,
  maxIterations: 50,
  timeoutMs: 172_800_000,
  iterationTimeoutMs: 10_800_000,
  reviewerTimeoutMs: 1_800_000,
} as const;

export type GoalLoopStatus = "running" | "done" | "partial" | "blocked" | "failed" | "cancelled";

export type GoalLoopPhase =
  | "goal_received"
  | "todo_generated"
  | "todo_executed"
  | "reviewed"
  | "complete"
  | "cancelled"
  | "failed";

export type GoalIterationStatus =
  | "pending"
  | "todo_generated"
  | "todo_executed"
  | "reviewed_incomplete"
  | "reviewed_complete"
  | "blocked"
  | "failed"
  | "cancelled";

export type GoalLoopStopKind = "cancelled" | "timeout" | "max_iterations" | "complete";

export interface GoalLoopLimits {
  minIterations: number;
  maxIterations: number;
  timeoutMs: number;
  iterationTimeoutMs: number;
  reviewerTimeoutMs: number;
}

export interface GoalLoopLimitInput {
  minIterations?: number;
  maxIterations?: number;
  timeoutMs?: number;
  iterationTimeoutMs?: number;
  reviewerTimeoutMs?: number;
}

export interface GoalLoopCancellation {
  requested: boolean;
  reason?: string;
  requestedAt?: string;
}

export interface GeneratedTodoState {
  todoPath: string;
  summary?: string;
  contentHash?: string;
  generatedAt: string;
  payloadPath?: string;
  rawTodoPath?: string;
  generatorRunId?: string;
  generatorRunDir?: string;
  generatorResultPath?: string;
  generatorTaskResultPath?: string;
}

export interface GoalWorkerResultState {
  status: CoordinatorStatus;
  summary: string;
  runId?: string;
  runDir?: string;
  todoPath?: string;
  resultPath?: string;
  taskResultPath?: string;
  workerProgressPath?: string;
  totalTasks?: number;
  completedTasks?: number;
  failedTasks?: number;
  blockedTasks?: number;
  workerCostTotal?: number;
  error?: string;
  startedAt?: string;
  endedAt: string;
}

export type GoalReviewerDecision = "complete" | "incomplete" | "blocked" | "failed";

export interface GoalReviewerResultState {
  decision: GoalReviewerDecision;
  complete: boolean;
  summary: string;
  rationale: string;
  remainingWork: string[];
  reviewerSessionId?: string;
  reviewerSessionFile?: string;
  payloadPath?: string;
  rawReviewPath?: string;
  reviewerCostTotal?: number;
  error?: string;
  reviewedAt: string;
}

export interface GoalCompletionState {
  status: GoalLoopStatus;
  reason: string;
  completedAt: string;
}

export interface GoalLoopTraceEvent {
  timestamp: string;
  phase: GoalLoopPhase;
  event: string;
  message: string;
  iteration?: number;
  details?: Record<string, unknown>;
}

export interface GoalIterationState {
  iteration: number;
  status: GoalIterationStatus;
  startedAt: string;
  updatedAt: string;
  deadlineAt?: string;
  generatedTodo?: GeneratedTodoState;
  workerResult?: GoalWorkerResultState;
  reviewerResult?: GoalReviewerResultState;
  completion?: GoalCompletionState;
}

export interface GoalLoopState {
  schemaVersion: typeof GOAL_LOOP_STATE_SCHEMA_VERSION;
  goalRunId: string;
  goalRunDir: string;
  goal: string;
  status: GoalLoopStatus;
  phase: GoalLoopPhase;
  limits: GoalLoopLimits;
  cancellation: GoalLoopCancellation;
  startedAt: string;
  updatedAt: string;
  deadlineAt?: string;
  currentIteration: number;
  iterations: GoalIterationState[];
  completion?: GoalCompletionState;
  trace: GoalLoopTraceEvent[];
}

export interface CreateGoalLoopStateOptions extends GoalLoopLimitInput {
  goal: string;
  cwd?: string;
  goalRunId: string;
  goalRunDir?: string;
  now?: () => Date;
}

export interface GoalLoopStopReason {
  kind: GoalLoopStopKind;
  message: string;
}

export class GoalLoopStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalLoopStateError";
  }
}

export function normalizeGoalLoopLimits(input: GoalLoopLimitInput = {}): GoalLoopLimits {
  const explicitMaxIterations = optionalPositiveInteger(input.maxIterations);
  const minIterations = positiveInteger(
    input.minIterations,
    explicitMaxIterations ?? DEFAULT_GOAL_LOOP_LIMITS.minIterations,
  );
  const maxIterations = Math.max(minIterations, explicitMaxIterations ?? DEFAULT_GOAL_LOOP_LIMITS.maxIterations);

  return {
    minIterations,
    maxIterations,
    timeoutMs: positiveMilliseconds(input.timeoutMs, DEFAULT_GOAL_LOOP_LIMITS.timeoutMs),
    iterationTimeoutMs: positiveMilliseconds(input.iterationTimeoutMs, DEFAULT_GOAL_LOOP_LIMITS.iterationTimeoutMs),
    reviewerTimeoutMs: positiveMilliseconds(input.reviewerTimeoutMs, DEFAULT_GOAL_LOOP_LIMITS.reviewerTimeoutMs),
  };
}

export function createGoalLoopState(options: CreateGoalLoopStateOptions): GoalLoopState {
  const now = options.now?.() ?? new Date();
  const startedAt = now.toISOString();
  const goal = options.goal.trim();
  if (!goal) {
    throw new GoalLoopStateError("Goal loop requires a non-empty goal.");
  }
  const limits = normalizeGoalLoopLimits(options);
  const goalRunDir =
    options.goalRunDir ??
    path.join(path.resolve(options.cwd ?? process.cwd()), "tmp", "pi-goal-task", options.goalRunId);
  const deadlineAt = new Date(now.getTime() + limits.timeoutMs).toISOString();
  const state: GoalLoopState = {
    schemaVersion: GOAL_LOOP_STATE_SCHEMA_VERSION,
    goalRunId: options.goalRunId,
    goalRunDir,
    goal,
    status: "running",
    phase: "goal_received",
    limits,
    cancellation: { requested: false },
    startedAt,
    updatedAt: startedAt,
    deadlineAt,
    currentIteration: 0,
    iterations: [],
    trace: [],
  };
  return withTrace(state, {
    timestamp: startedAt,
    phase: "goal_received",
    event: "goal_received",
    message: "Goal loop received goal.",
    details: { goal, limits },
  });
}

export function goalLoopStopReason(
  state: GoalLoopState,
  options: { now?: Date; abortSignal?: AbortSignal } = {},
): GoalLoopStopReason | undefined {
  if (isTerminalGoalLoopStatus(state.status)) {
    return { kind: "complete", message: `Goal loop is already ${state.status}.` };
  }
  if (state.cancellation.requested) {
    return { kind: "cancelled", message: state.cancellation.reason ?? "Goal loop cancellation requested." };
  }
  if (options.abortSignal?.aborted) {
    return { kind: "cancelled", message: "Goal loop abort signal was triggered." };
  }

  const nowMs = options.now?.getTime() ?? Date.now();
  if (state.deadlineAt && nowMs >= Date.parse(state.deadlineAt)) {
    return { kind: "timeout", message: `Goal loop timed out after ${state.limits.timeoutMs}ms.` };
  }

  if (state.phase === "reviewed" && state.iterations.length >= state.limits.maxIterations) {
    return {
      kind: "max_iterations",
      message: `Goal loop reached maxIterations=${state.limits.maxIterations}.`,
    };
  }
  return undefined;
}

export function startGoalIteration(
  state: GoalLoopState,
  options: { now?: Date; abortSignal?: AbortSignal } = {},
): GoalLoopState {
  const now = options.now ?? new Date();
  const stopReason = goalLoopStopReason(state, { now, abortSignal: options.abortSignal });
  if (stopReason) {
    return completeStateForStopReason(state, stopReason, now);
  }
  if (!canStartAnotherIterationFromPhase(state.phase)) {
    throw new GoalLoopStateError(`Cannot start goal iteration from phase ${state.phase}.`);
  }

  const iteration = state.iterations.length + 1;
  const timestamp = now.toISOString();
  const deadlineAt = new Date(now.getTime() + state.limits.iterationTimeoutMs).toISOString();
  return withTrace(
    {
      ...state,
      phase: "goal_received",
      currentIteration: iteration,
      updatedAt: timestamp,
      iterations: [
        ...state.iterations,
        {
          iteration,
          status: "pending",
          startedAt: timestamp,
          updatedAt: timestamp,
          deadlineAt,
        },
      ],
    },
    {
      timestamp,
      phase: "goal_received",
      event: "iteration_started",
      message: `Goal loop iteration ${iteration} started.`,
      iteration,
      details: { deadlineAt },
    },
  );
}

export function recordGeneratedTodo(
  state: GoalLoopState,
  iteration: number,
  todo: Omit<GeneratedTodoState, "generatedAt"> & { generatedAt?: string },
  options: { now?: Date } = {},
): GoalLoopState {
  const timestamp = (options.now ?? new Date()).toISOString();
  return updateIteration(state, iteration, ["pending"], timestamp, (item) => ({
    item: {
      ...item,
      status: "todo_generated",
      updatedAt: timestamp,
      generatedTodo: {
        ...todo,
        generatedAt: todo.generatedAt ?? timestamp,
      },
    },
    phase: "todo_generated",
    trace: {
      timestamp,
      phase: "todo_generated",
      event: "todo_generated",
      message: `Goal loop iteration ${iteration} generated TODO markdown.`,
      iteration,
      details: { todoPath: todo.todoPath, summary: todo.summary, contentHash: todo.contentHash },
    },
  }));
}

export function recordWorkerResult(
  state: GoalLoopState,
  iteration: number,
  workerResult: GoalWorkerResultState,
  options: { now?: Date } = {},
): GoalLoopState {
  const timestamp = (options.now ?? new Date()).toISOString();
  return updateIteration(state, iteration, ["todo_generated"], timestamp, (item) => ({
    item: {
      ...item,
      status: workerResult.status === "failed" ? "failed" : "todo_executed",
      updatedAt: timestamp,
      workerResult,
    },
    phase: "todo_executed",
    trace: {
      timestamp,
      phase: "todo_executed",
      event: "todo_executed",
      message: `Goal loop iteration ${iteration} worker finished with status ${workerResult.status}.`,
      iteration,
      details: { status: workerResult.status, runId: workerResult.runId, summary: workerResult.summary },
    },
  }));
}

export function recordReviewerResult(
  state: GoalLoopState,
  iteration: number,
  reviewerResult: GoalReviewerResultState,
  options: { now?: Date } = {},
): GoalLoopState {
  const timestamp = (options.now ?? new Date()).toISOString();
  return updateIteration(state, iteration, ["todo_executed", "failed"], timestamp, (item) => {
    const terminalStatus = terminalStatusFromReviewer(reviewerResult);
    const completion = terminalStatus
      ? { status: terminalStatus, reason: reviewerResult.rationale, completedAt: timestamp }
      : undefined;
    return {
      item: {
        ...item,
        status:
          reviewerResult.decision === "complete"
            ? "reviewed_complete"
            : reviewerResult.decision === "blocked"
              ? "blocked"
              : reviewerResult.decision === "failed"
                ? "failed"
                : "reviewed_incomplete",
        updatedAt: timestamp,
        reviewerResult,
        completion,
      },
      phase: terminalStatus ? "complete" : "reviewed",
      status: terminalStatus ?? "running",
      completion,
      trace: {
        timestamp,
        phase: terminalStatus ? "complete" : "reviewed",
        event: "reviewed",
        message: terminalStatus
          ? `Goal loop iteration ${iteration} reviewer completed with ${terminalStatus}.`
          : `Goal loop iteration ${iteration} reviewer requested another iteration.`,
        iteration,
        details: {
          decision: reviewerResult.decision,
          complete: reviewerResult.complete,
          summary: reviewerResult.summary,
          remainingWork: reviewerResult.remainingWork,
        },
      },
    };
  });
}

export function cancelGoalLoop(
  state: GoalLoopState,
  reason = "Goal loop cancellation requested.",
  options: { now?: Date } = {},
): GoalLoopState {
  const timestamp = (options.now ?? new Date()).toISOString();
  const completion: GoalCompletionState = { status: "cancelled", reason, completedAt: timestamp };
  const iterations = state.iterations.map((iteration) =>
    iteration.iteration === state.currentIteration && !isTerminalIterationStatus(iteration.status)
      ? { ...iteration, status: "cancelled" as const, updatedAt: timestamp, completion }
      : iteration,
  );
  return withTrace(
    {
      ...state,
      status: "cancelled",
      phase: "cancelled",
      cancellation: { requested: true, reason, requestedAt: timestamp },
      completion,
      iterations,
      updatedAt: timestamp,
    },
    {
      timestamp,
      phase: "cancelled",
      event: "cancelled",
      message: reason,
      iteration: state.currentIteration || undefined,
    },
  );
}

export function validateGoalLoopState(value: unknown): GoalLoopState {
  if (!value || typeof value !== "object") {
    throw new GoalLoopStateError("Goal loop state must be an object.");
  }
  const state = value as Partial<GoalLoopState>;
  if (state.schemaVersion !== GOAL_LOOP_STATE_SCHEMA_VERSION) {
    throw new GoalLoopStateError(`Unsupported goal loop state schemaVersion: ${String(state.schemaVersion)}.`);
  }
  if (!state.goalRunId || typeof state.goalRunId !== "string") {
    throw new GoalLoopStateError("Goal loop state is missing goalRunId.");
  }
  if (!state.goalRunDir || typeof state.goalRunDir !== "string") {
    throw new GoalLoopStateError("Goal loop state is missing goalRunDir.");
  }
  if (!state.goal || typeof state.goal !== "string") {
    throw new GoalLoopStateError("Goal loop state is missing goal.");
  }
  if (!state.limits || typeof state.limits !== "object") {
    throw new GoalLoopStateError("Goal loop state is missing limits.");
  }
  state.limits = normalizeGoalLoopLimits({
    ...state.limits,
    minIterations: state.limits.minIterations ?? DEFAULT_GOAL_LOOP_LIMITS.minIterations,
  });
  if (!Array.isArray(state.iterations) || !Array.isArray(state.trace)) {
    throw new GoalLoopStateError("Goal loop state is missing iterations or trace arrays.");
  }
  return state as GoalLoopState;
}

function updateIteration(
  state: GoalLoopState,
  iterationNumber: number,
  allowedStatuses: readonly GoalIterationStatus[],
  timestamp: string,
  update: (item: GoalIterationState) => {
    item: GoalIterationState;
    phase: GoalLoopPhase;
    trace: GoalLoopTraceEvent;
    status?: GoalLoopStatus;
    completion?: GoalCompletionState;
  },
): GoalLoopState {
  if (isTerminalGoalLoopStatus(state.status)) {
    throw new GoalLoopStateError(`Cannot update a terminal goal loop with status ${state.status}.`);
  }
  const index = state.iterations.findIndex((item) => item.iteration === iterationNumber);
  if (index < 0) {
    throw new GoalLoopStateError(`Goal iteration ${iterationNumber} does not exist.`);
  }
  const item = state.iterations[index];
  if (!item || !allowedStatuses.includes(item.status)) {
    throw new GoalLoopStateError(
      `Cannot update goal iteration ${iterationNumber} from status ${item?.status ?? "unknown"}.`,
    );
  }
  const result = update(item);
  const iterations = state.iterations.map((candidate, candidateIndex) =>
    candidateIndex === index ? result.item : candidate,
  );
  return withTrace(
    {
      ...state,
      status: result.status ?? state.status,
      phase: result.phase,
      completion: result.completion ?? state.completion,
      iterations,
      updatedAt: timestamp,
    },
    result.trace,
  );
}

function completeStateForStopReason(state: GoalLoopState, stopReason: GoalLoopStopReason, now: Date): GoalLoopState {
  if (stopReason.kind === "complete") {
    return state;
  }
  if (stopReason.kind === "cancelled") {
    return cancelGoalLoop(state, stopReason.message, { now });
  }

  const status: GoalLoopStatus = stopReason.kind === "timeout" ? "partial" : "failed";
  const phase: GoalLoopPhase = status === "failed" ? "failed" : "complete";
  const timestamp = now.toISOString();
  const completion: GoalCompletionState = { status, reason: stopReason.message, completedAt: timestamp };
  return withTrace(
    {
      ...state,
      status,
      phase,
      completion,
      updatedAt: timestamp,
    },
    {
      timestamp,
      phase,
      event: stopReason.kind,
      message: stopReason.message,
      iteration: state.currentIteration || undefined,
    },
  );
}

function terminalStatusFromReviewer(result: GoalReviewerResultState): GoalLoopStatus | undefined {
  if (result.decision === "complete" || result.complete) {
    return "done";
  }
  if (result.decision === "blocked") {
    return "blocked";
  }
  if (result.decision === "failed") {
    return "failed";
  }
  return undefined;
}

function canStartAnotherIterationFromPhase(phase: GoalLoopPhase): boolean {
  return phase === "goal_received" || phase === "reviewed";
}

function isTerminalGoalLoopStatus(status: GoalLoopStatus): boolean {
  return (
    status === "done" || status === "partial" || status === "blocked" || status === "failed" || status === "cancelled"
  );
}

function isTerminalIterationStatus(status: GoalIterationStatus): boolean {
  return status === "reviewed_complete" || status === "blocked" || status === "failed" || status === "cancelled";
}

function withTrace(state: GoalLoopState, event: GoalLoopTraceEvent): GoalLoopState {
  return { ...state, trace: [...state.trace, event] };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return optionalPositiveInteger(value) ?? fallback;
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}
