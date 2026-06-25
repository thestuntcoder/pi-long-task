import { randomUUID } from "node:crypto";

import type { CoordinatorProgressUpdate } from "./coordinator.ts";
import type { GoalLoopLimits, GoalLoopStatus } from "./goal_loop.ts";
import {
  createGoalLoopState,
  goalLoopStopReason,
  startGoalIteration,
  type GoalLoopLimitInput,
  type GoalLoopState,
} from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import { runGoalReviewSession, type GoalReviewResult, type GoalReviewerRunner } from "./goal_review.ts";
import {
  runGoalTodoExecutionLongTask,
  type GoalTodoExecutionLongTaskRunner,
  type GoalTodoExecutionResult,
  GoalTodoExecutionError,
} from "./goal_todo_execution.ts";
import {
  runGoalTodoGenerationLongTask,
  type GoalTodoGenerationLongTaskRunner,
  type GoalTodoGenerationResult,
} from "./goal_todo_generation.ts";

export type GoalLoopProgressPhase =
  | "goal_start"
  | "todo_generation_start"
  | "todo_generated"
  | "todo_execution_start"
  | "todo_executed"
  | "review_start"
  | "reviewed"
  | "complete";

export interface GoalLoopProgressUpdate {
  message: string;
  phase: GoalLoopProgressPhase;
  goalRunId: string;
  goalRunDir: string;
  goal: string;
  status: GoalLoopStatus;
  currentIteration: number;
  totalIterations: number;
  maxIterations: number;
  limits: GoalLoopLimits;
  resultPath: string;
  statePath: string;
  tracePath: string;
  iteration?: number;
  reviewerDecision?: string;
  remainingWork?: string[];
  workerStatus?: string;
  workerCostTotal: number;
  reviewerCostTotal: number;
  totalCost: number;
  childProgress?: CoordinatorProgressUpdate;
}

export type GoalLoopProgressHandler = (update: GoalLoopProgressUpdate) => void;

export interface RunGoalLoopOptions extends GoalLoopLimitInput {
  goal?: string;
  initialState?: GoalLoopState;
  cwd?: string;
  goalRunId?: string;
  goalRunDir?: string;
  store?: GoalStateStore;
  abortSignal?: AbortSignal;
  todoGenerationRunner?: GoalTodoGenerationLongTaskRunner;
  todoExecutionRunner?: GoalTodoExecutionLongTaskRunner;
  reviewerRunner?: GoalReviewerRunner;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  maxBashTimeoutMs?: number;
  maxAttemptsPerTask?: number;
  commit?: boolean;
  now?: () => Date;
  onWorkerProgress?: (update: CoordinatorProgressUpdate) => void;
  onProgress?: GoalLoopProgressHandler;
}

export interface GoalLoopRunResult {
  state: GoalLoopState;
  generationResults: GoalTodoGenerationResult[];
  executionResults: GoalTodoExecutionResult[];
  reviewResults: GoalReviewResult[];
  resultPath: string;
}

export class GoalLoopOrchestratorError extends Error {
  readonly state: GoalLoopState | undefined;

  constructor(message: string, options: { cause?: unknown; state?: GoalLoopState } = {}) {
    super(message, { cause: options.cause });
    this.name = "GoalLoopOrchestratorError";
    this.state = options.state;
  }
}

export async function runGoalLoop(options: RunGoalLoopOptions): Promise<GoalLoopRunResult> {
  const now = options.now ?? (() => new Date());
  let state =
    options.initialState ??
    createGoalLoopState({
      goal: requiredGoal(options.goal),
      cwd: options.cwd,
      goalRunId:
        options.goalRunId ?? `goal-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
      goalRunDir: options.goalRunDir,
      maxIterations: options.maxIterations,
      timeoutMs: options.timeoutMs,
      iterationTimeoutMs: options.iterationTimeoutMs,
      reviewerTimeoutMs: options.reviewerTimeoutMs,
      now,
    });
  const store =
    options.store ?? new GoalStateStore({ cwd: options.cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });
  const generationResults: GoalTodoGenerationResult[] = [];
  const executionResults: GoalTodoExecutionResult[] = [];
  const reviewResults: GoalReviewResult[] = [];

  await store.saveState(state);
  await store.initializeResult(state);
  await store.appendNewTraceEvents(0, state);
  const publish = (phase: GoalLoopProgressPhase, message: string, extra: Partial<GoalLoopProgressUpdate> = {}) => {
    options.onProgress?.({
      message,
      phase,
      goalRunId: state.goalRunId,
      goalRunDir: state.goalRunDir,
      goal: state.goal,
      status: state.status,
      currentIteration: state.currentIteration,
      totalIterations: state.iterations.length,
      maxIterations: state.limits.maxIterations,
      limits: state.limits,
      resultPath: store.paths.resultPath,
      statePath: store.paths.statePath,
      tracePath: store.paths.tracePath,
      workerCostTotal: accumulatedWorkerCost(executionResults, generationResults),
      reviewerCostTotal: accumulatedReviewerCost(reviewResults),
      totalCost: accumulatedWorkerCost(executionResults, generationResults) + accumulatedReviewerCost(reviewResults),
      ...extra,
    });
  };

  publish("goal_start", `Starting goal loop: ${state.goal}`);

  while (state.status === "running") {
    const stopReason = goalLoopStopReason(state, { now: now(), abortSignal: options.abortSignal });
    if (stopReason) {
      const previousTraceLength = state.trace.length;
      state = startGoalIteration(state, { now: now(), abortSignal: options.abortSignal });
      await persistStateChange(store, previousTraceLength, state);
      break;
    }

    const nextIteration = state.currentIteration > 0 ? state.currentIteration : state.iterations.length + 1;
    publish("todo_generation_start", `Goal iteration ${nextIteration}: generating TODO markdown.`, {
      iteration: nextIteration,
    });
    const generation = await runGoalTodoGenerationLongTask({
      state,
      cwd: options.cwd,
      store,
      longTaskRunner: options.todoGenerationRunner,
      abortSignal: options.abortSignal,
      model: options.model,
      modelName: options.modelName,
      thinkingLevel: options.thinkingLevel,
      maxBashTimeoutMs: options.maxBashTimeoutMs,
      now,
    });
    generationResults.push(generation);
    state = generation.state;
    publish("todo_generated", `Goal iteration ${state.currentIteration}: generated TODO markdown.`, {
      iteration: state.currentIteration,
    });

    try {
      publish(
        "todo_execution_start",
        `Goal iteration ${state.currentIteration}: running generated TODO as a long task.`,
        {
          iteration: state.currentIteration,
        },
      );
      const execution = await runGoalTodoExecutionLongTask({
        state,
        cwd: options.cwd,
        store,
        longTaskRunner: options.todoExecutionRunner,
        abortSignal: options.abortSignal,
        model: options.model,
        modelName: options.modelName,
        thinkingLevel: options.thinkingLevel,
        maxBashTimeoutMs: options.maxBashTimeoutMs,
        maxAttemptsPerTask: options.maxAttemptsPerTask,
        commit: options.commit,
        now,
        onProgress: (update) => {
          publish("todo_execution_start", `Goal iteration ${state.currentIteration}: ${update.message}`, {
            iteration: state.currentIteration,
            workerStatus: update.status,
            childProgress: update,
          });
          options.onWorkerProgress?.(update);
        },
      });
      executionResults.push(execution);
      state = execution.state;
      publish(
        "todo_executed",
        `Goal iteration ${state.currentIteration}: worker finished with ${execution.childResult.status}.`,
        {
          iteration: state.currentIteration,
          workerStatus: execution.childResult.status,
        },
      );
    } catch (error) {
      if (error instanceof GoalTodoExecutionError && error.state) {
        state = error.state;
      } else {
        throw new GoalLoopOrchestratorError(`Goal TODO execution failed: ${errorMessage(error)}`, {
          cause: error,
          state,
        });
      }
    }

    publish("review_start", `Goal iteration ${state.currentIteration}: reviewing goal completion.`, {
      iteration: state.currentIteration,
    });
    const review = await runGoalReviewSession({
      state,
      cwd: options.cwd,
      store,
      reviewerRunner: options.reviewerRunner,
      abortSignal: options.abortSignal,
      model: options.model,
      modelName: options.modelName,
      thinkingLevel: options.thinkingLevel,
      now,
    });
    reviewResults.push(review);
    state = review.state;
    publish(
      "reviewed",
      `Goal iteration ${review.iteration.iteration}: reviewer decided ${review.reviewerResult.decision}.`,
      {
        iteration: review.iteration.iteration,
        reviewerDecision: review.reviewerResult.decision,
        remainingWork: review.reviewerResult.remainingWork,
      },
    );
  }

  publish("complete", `Goal loop ${state.status}: ${state.completion?.reason ?? "finished"}`);

  return {
    state,
    generationResults,
    executionResults,
    reviewResults,
    resultPath: store.paths.resultPath,
  };
}

async function persistStateChange(
  store: GoalStateStore,
  previousTraceLength: number,
  state: GoalLoopState,
): Promise<void> {
  await store.saveState(state);
  await store.appendNewTraceEvents(previousTraceLength, state);
}

function accumulatedWorkerCost(
  executionResults: GoalTodoExecutionResult[],
  generationResults: GoalTodoGenerationResult[],
): number {
  return sumFinite([
    ...executionResults.map((result) => result.childResult.workerCostTotal),
    ...generationResults.map((result) => result.childResult.workerCostTotal),
  ]);
}

function accumulatedReviewerCost(reviewResults: GoalReviewResult[]): number {
  return sumFinite(reviewResults.map((result) => result.sessionResult.reviewerCostTotal));
}

function sumFinite(values: Array<number | undefined>): number {
  return values.reduce<number>(
    (total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

function requiredGoal(goal: string | undefined): string {
  const trimmed = goal?.trim();
  if (!trimmed) {
    throw new GoalLoopOrchestratorError("Goal loop requires a non-empty goal.");
  }
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
