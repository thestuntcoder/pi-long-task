import { randomUUID } from "node:crypto";

import type { CoordinatorProgressUpdate } from "./coordinator.ts";
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

  while (state.status === "running") {
    const stopReason = goalLoopStopReason(state, { now: now(), abortSignal: options.abortSignal });
    if (stopReason) {
      const previousTraceLength = state.trace.length;
      state = startGoalIteration(state, { now: now(), abortSignal: options.abortSignal });
      await persistStateChange(store, previousTraceLength, state);
      break;
    }

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

    try {
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
        onProgress: options.onWorkerProgress,
      });
      executionResults.push(execution);
      state = execution.state;
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
  }

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
