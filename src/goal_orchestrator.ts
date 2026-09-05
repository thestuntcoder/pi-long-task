import { randomUUID } from "node:crypto";

import type { CoordinatorProgressUpdate } from "./coordinator.ts";
import {
  decideGoalDiscovery,
  runDefaultGoalDiscovery,
  type GoalDiscoveryDecision,
  type GoalDiscoveryEntrypoint,
  type GoalDiscoveryRunner,
} from "./goal_discovery.ts";
import type { GoalIterationStatus, GoalLoopLimits, GoalLoopStatus } from "./goal_loop.ts";
import {
  cancelGoalLoop,
  createGoalLoopState,
  failGoalLoop,
  goalLoopStopReason,
  startGoalIteration,
  type GoalLoopLimitInput,
  type GoalLoopState,
} from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import type { GoalSpecification } from "./goal_spec.ts";
import {
  resolveNetworkRecoveryConfig,
  type NetworkRecoveryConfig,
  type NetworkRecoveryConfigInput,
} from "./network_recovery_config.ts";
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
  | "discovery_start"
  | "discovery_complete"
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
  minIterations: number;
  maxIterations: number;
  limits: GoalLoopLimits;
  resultPath: string;
  statePath: string;
  tracePath: string;
  goalSpecPath: string;
  discoveryDecision: GoalDiscoveryDecision;
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
  discoveryRunner?: GoalDiscoveryRunner;
  discoveryEntrypoint?: GoalDiscoveryEntrypoint;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  maxBashTimeoutMs?: number;
  maxAttemptsPerTask?: number;
  networkRecovery?: NetworkRecoveryConfigInput;
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
  discoveryDecision: GoalDiscoveryDecision;
  goalSpecification?: GoalSpecification;
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
  const networkRecovery = resolveNetworkRecoveryConfig(options.networkRecovery);
  let state =
    options.initialState ??
    createGoalLoopState({
      goal: requiredGoal(options.goal),
      cwd: options.cwd,
      goalRunId:
        options.goalRunId ?? `goal-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
      goalRunDir: options.goalRunDir,
      minIterations: options.minIterations,
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
  const discoveryDecision = decideGoalDiscovery({
    goal: state.goal,
    entrypoint: options.discoveryEntrypoint ?? "pi_goal_task",
  });
  let goalSpecification: GoalSpecification | undefined = await store.tryLoadGoalSpecification();

  await store.saveState(state);
  await store.initializeResultIfMissing(state);
  await store.appendNewTraceEvents(await store.durableTraceLength(), state);
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
      minIterations: state.limits.minIterations,
      maxIterations: state.limits.maxIterations,
      limits: state.limits,
      resultPath: store.paths.resultPath,
      statePath: store.paths.statePath,
      tracePath: store.paths.tracePath,
      goalSpecPath: store.paths.goalSpecPath,
      discoveryDecision,
      workerCostTotal: accumulatedWorkerCost(state),
      reviewerCostTotal: accumulatedReviewerCost(state),
      totalCost: accumulatedWorkerCost(state) + accumulatedReviewerCost(state),
      ...extra,
    });
  };

  publish("goal_start", `Starting goal loop: ${state.goal}`);

  try {
    if (!goalLoopStopReason(state, { now: now(), abortSignal: options.abortSignal })) {
      goalSpecification = await maybeRunGoalDiscovery({
        state,
        store,
        discoveryDecision,
        existingSpecification: goalSpecification,
        options,
        now,
        publish,
        networkRecovery,
      });
    }

    while (state.status === "running") {
      const phaseNow = now();
      const stopReason = goalLoopStopReason(state, { now: phaseNow, abortSignal: options.abortSignal });
      if (stopReason) {
        const previousTraceLength = state.trace.length;
        state = startGoalIteration(state, { now: phaseNow, abortSignal: options.abortSignal });
        await persistStateChange(store, previousTraceLength, state);
        break;
      }

      const current = state.iterations.find((item) => item.iteration === state.currentIteration);
      if (current && isActiveIterationPhase(current.status) && deadlineExpired(current.deadlineAt, phaseNow)) {
        const previousTraceLength = state.trace.length;
        state = failGoalLoop(state, `Goal iteration ${current.iteration} exceeded its iteration deadline.`, {
          now: phaseNow,
          status: "partial",
        });
        await persistStateChange(store, previousTraceLength, state);
        break;
      }

      const currentStatus = current?.status;
      if (!current || currentStatus === "reviewed_incomplete") {
        const nextIteration = state.iterations.length + 1;
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
          networkRecovery,
          now,
          goalSpecification,
        });
        generationResults.push(generation);
        state = generation.state;
        publish("todo_generated", `Goal iteration ${state.currentIteration}: generated TODO markdown.`, {
          iteration: state.currentIteration,
        });
        continue;
      }

      if (currentStatus === "pending") {
        publish("todo_generation_start", `Goal iteration ${current.iteration}: resuming TODO generation.`, {
          iteration: current.iteration,
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
          networkRecovery,
          now,
          goalSpecification,
        });
        generationResults.push(generation);
        state = generation.state;
        publish("todo_generated", `Goal iteration ${state.currentIteration}: generated TODO markdown.`, {
          iteration: state.currentIteration,
        });
        continue;
      }

      if (currentStatus === "todo_generated") {
        publish("todo_execution_start", `Goal iteration ${current.iteration}: running generated TODO as a long task.`, {
          iteration: current.iteration,
        });
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
            networkRecovery,
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
            throw error;
          }
        }
        continue;
      }

      if (currentStatus === "todo_executed" || currentStatus === "failed") {
        publish("review_start", `Goal iteration ${current.iteration}: reviewing goal completion.`, {
          iteration: current.iteration,
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
          goalSpecification,
          networkRecovery,
          timeoutMs: remainingReviewTimeout(state, current.deadlineAt, now()),
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
        continue;
      }

      throw new GoalLoopOrchestratorError(`Cannot resume goal iteration ${current.iteration} from ${currentStatus}.`, {
        state,
      });
    }
  } catch (error) {
    const errorState = stateFromError(error);
    if (errorState) {
      state = errorState;
    } else {
      try {
        state = await store.loadState();
      } catch {
        // Retain the latest in-memory state when no newer durable state is available.
      }
    }
    if (state.status === "running") {
      const previousTraceLength = state.trace.length;
      state = options.abortSignal?.aborted
        ? cancelGoalLoop(state, `Goal loop aborted: ${errorMessage(error)}`, { now: now() })
        : failGoalLoop(state, `Goal loop failed: ${errorMessage(error)}`, { now: now() });
      await persistStateChange(store, previousTraceLength, state);
    }
  }

  publish("complete", `Goal loop ${state.status}: ${state.completion?.reason ?? "finished"}`);

  return {
    state,
    generationResults,
    executionResults,
    reviewResults,
    resultPath: store.paths.resultPath,
    discoveryDecision,
    ...(goalSpecification ? { goalSpecification } : {}),
  };
}

async function maybeRunGoalDiscovery(options: {
  state: GoalLoopState;
  store: GoalStateStore;
  discoveryDecision: GoalDiscoveryDecision;
  existingSpecification?: GoalSpecification;
  options: RunGoalLoopOptions;
  now: () => Date;
  publish: (phase: GoalLoopProgressPhase, message: string, extra?: Partial<GoalLoopProgressUpdate>) => void;
  networkRecovery: Readonly<NetworkRecoveryConfig>;
}): Promise<GoalSpecification | undefined> {
  if (options.discoveryDecision.route !== "discovery") {
    return options.existingSpecification;
  }

  if (options.existingSpecification) {
    options.publish("discovery_complete", "Using persisted goal specification from previous discovery.");
    return options.existingSpecification;
  }

  options.publish("discovery_start", "Goal is vague; running discovery before implementation TODO generation.");
  try {
    const runner = options.options.discoveryRunner ?? runDefaultGoalDiscovery;
    const spec = await runner({
      state: options.state,
      store: options.store,
      decision: options.discoveryDecision,
      cwd: options.options.cwd,
      abortSignal: options.options.abortSignal,
      model: options.options.model,
      modelName: options.options.modelName,
      thinkingLevel: options.options.thinkingLevel,
      networkRecovery: options.networkRecovery,
      now: options.now,
    });
    await options.store.saveGoalSpecification(spec);
    options.publish(
      "discovery_complete",
      `Goal discovery complete; specification saved to ${options.store.paths.goalSpecPath}.`,
    );
    return spec;
  } catch (error) {
    throw new GoalLoopOrchestratorError(`Goal discovery failed: ${errorMessage(error)}`, {
      cause: error,
      state: options.state,
    });
  }
}

async function persistStateChange(
  store: GoalStateStore,
  previousTraceLength: number,
  state: GoalLoopState,
): Promise<void> {
  await store.saveState(state);
  await store.appendNewTraceEvents(previousTraceLength, state);
}

function isActiveIterationPhase(status: GoalIterationStatus): boolean {
  return status === "pending" || status === "todo_generated" || status === "todo_executed" || status === "failed";
}

function deadlineExpired(deadlineAt: string | undefined, now: Date): boolean {
  return Boolean(deadlineAt && now.getTime() >= Date.parse(deadlineAt));
}

function remainingReviewTimeout(state: GoalLoopState, iterationDeadlineAt: string | undefined, now: Date): number {
  const remaining = [
    state.limits.reviewerTimeoutMs,
    state.deadlineAt ? Date.parse(state.deadlineAt) - now.getTime() : Number.POSITIVE_INFINITY,
    iterationDeadlineAt ? Date.parse(iterationDeadlineAt) - now.getTime() : Number.POSITIVE_INFINITY,
  ].filter((value) => Number.isFinite(value));
  return Math.max(1, Math.floor(Math.min(...remaining)));
}

function stateFromError(error: unknown): GoalLoopState | undefined {
  if (typeof error !== "object" || error === null || !("state" in error)) {
    return undefined;
  }
  const state = (error as { state?: unknown }).state;
  return state && typeof state === "object" ? (state as GoalLoopState) : undefined;
}

function accumulatedWorkerCost(state: GoalLoopState): number {
  return sumFinite(
    state.iterations.flatMap((iteration) => [
      iteration.generatedTodo?.generatorWorkerCostTotal,
      iteration.workerResult?.workerCostTotal,
    ]),
  );
}

function accumulatedReviewerCost(state: GoalLoopState): number {
  return sumFinite(state.iterations.map((iteration) => iteration.reviewerResult?.reviewerCostTotal));
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
