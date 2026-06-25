import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runCoordinator,
  type CoordinatorProgressUpdate,
  type CoordinatorResult,
  type RunCoordinatorOptions,
} from "./coordinator.ts";
import {
  cancelGoalLoop,
  type GoalIterationState,
  type GoalLoopState,
  type GoalWorkerResultState,
  recordWorkerResult,
} from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import { validateTodoMarkdown } from "./todo_generator.ts";

export const GOAL_TODO_EXECUTION_PROGRESS_FILE = "WORKER_PROGRESS.jsonl";

export type GoalTodoExecutionLongTaskRunner = (options: RunCoordinatorOptions) => Promise<CoordinatorResult>;

export interface GoalTodoExecutionOptions {
  state: GoalLoopState;
  cwd?: string;
  store?: GoalStateStore;
  longTaskRunner?: GoalTodoExecutionLongTaskRunner;
  abortSignal?: AbortSignal;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  maxBashTimeoutMs?: number;
  maxAttemptsPerTask?: number;
  commit?: boolean;
  now?: () => Date;
  onProgress?: (update: CoordinatorProgressUpdate) => void;
}

export interface GoalTodoExecutionResult {
  state: GoalLoopState;
  iteration: GoalIterationState;
  todoMarkdown: string;
  todoPath: string;
  progressLogPath: string;
  childResult: CoordinatorResult;
}

export class GoalTodoExecutionError extends Error {
  readonly state: GoalLoopState | undefined;
  readonly workerResult: GoalWorkerResultState | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; state?: GoalLoopState; workerResult?: GoalWorkerResultState } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GoalTodoExecutionError";
    this.state = options.state;
    this.workerResult = options.workerResult;
  }
}

export async function runGoalTodoExecutionLongTask(
  options: GoalTodoExecutionOptions,
): Promise<GoalTodoExecutionResult> {
  const now = options.now ?? (() => new Date());
  let state = options.state;
  let previousTraceLength = state.trace.length;
  const store =
    options.store ?? new GoalStateStore({ cwd: options.cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });

  const iteration = currentGeneratedIteration(state);
  const iterationDir = store.iterationDir(iteration.iteration);
  await mkdir(iterationDir, { recursive: true });
  const progressLogPath = path.join(iterationDir, GOAL_TODO_EXECUTION_PROGRESS_FILE);

  if (options.abortSignal?.aborted) {
    state = cancelGoalLoop(state, "TODO execution was aborted before starting.", { now: now() });
    await persistStateChange(store, previousTraceLength, state);
    await store.writeIterationSnapshot(currentIteration(state, iteration.iteration));
    throw new GoalTodoExecutionError("TODO execution was aborted before starting.", { state });
  }

  const todoPath = iteration.generatedTodo?.todoPath;
  if (!todoPath) {
    throw new GoalTodoExecutionError(`Goal iteration ${iteration.iteration} does not have a generated TODO path.`, {
      state,
    });
  }

  const todoMarkdown = await readExecutionTodoOrRecordFailure({
    state,
    iteration,
    todoPath,
    store,
    previousTraceLength,
    now,
  });
  state = todoMarkdown.state;
  previousTraceLength = todoMarkdown.previousTraceLength;
  try {
    validateTodoMarkdown(todoMarkdown.content);
  } catch (error) {
    const failure = await recordExecutionFailure({
      state,
      iteration,
      store,
      previousTraceLength,
      message: `Generated TODO ${todoPath} is not valid Pi Long Task markdown: ${errorMessage(error)}`,
      error,
      now,
    });
    throw new GoalTodoExecutionError(failure.workerResult.summary, {
      cause: error,
      state: failure.state,
      workerResult: failure.workerResult,
    });
  }

  const progressEvents: CoordinatorProgressUpdate[] = [];
  const workerStartedAt = now();
  let childResult: CoordinatorResult;
  try {
    childResult = await (options.longTaskRunner ?? runCoordinator)({
      inputText: todoMarkdown.content,
      commit: options.commit ?? true,
      goal: state.goal,
      cwd: options.cwd,
      runId: `${state.goalRunId}-todo-worker-${String(iteration.iteration).padStart(2, "0")}`,
      abortSignal: options.abortSignal,
      workerModel: options.model,
      workerModelName: options.modelName,
      taskThinking: options.thinkingLevel,
      taskTimeoutMs: timeoutForIteration(iteration, state, now()),
      maxBashTimeoutMs: options.maxBashTimeoutMs,
      maxAttemptsPerTask: options.maxAttemptsPerTask,
      onProgress: (update) => {
        progressEvents.push(update);
        options.onProgress?.(update);
      },
    });
  } catch (error) {
    await writeProgressLog(progressLogPath, progressEvents);
    const failure = await recordExecutionFailure({
      state,
      iteration,
      store,
      previousTraceLength,
      progressLogPath,
      message: `TODO execution long task failed: ${errorMessage(error)}`,
      error,
      now,
    });
    throw new GoalTodoExecutionError(failure.workerResult.summary, {
      cause: error,
      state: failure.state,
      workerResult: failure.workerResult,
    });
  }

  await writeProgressLog(progressLogPath, progressEvents);

  const workerResult = workerResultFromCoordinatorResult(childResult, progressLogPath, workerStartedAt, now());
  state = recordWorkerResult(state, iteration.iteration, workerResult, { now: now() });
  await persistStateChange(store, previousTraceLength, state);
  const updatedIteration = currentIteration(state, iteration.iteration);
  await store.writeIterationSnapshot(updatedIteration);
  await store.appendIterationResult(updatedIteration);

  return {
    state,
    iteration: updatedIteration,
    todoMarkdown: todoMarkdown.content,
    todoPath,
    progressLogPath,
    childResult,
  };
}

function currentGeneratedIteration(state: GoalLoopState): GoalIterationState {
  const iteration = currentIteration(state, state.currentIteration);
  if (iteration.status !== "todo_generated") {
    throw new GoalTodoExecutionError(
      `Goal iteration ${iteration.iteration} is ${iteration.status}; expected generated TODO execution.`,
      { state },
    );
  }
  return iteration;
}

function currentIteration(state: GoalLoopState, iterationNumber: number): GoalIterationState {
  const iteration = state.iterations.find((item) => item.iteration === iterationNumber);
  if (!iteration) {
    throw new GoalTodoExecutionError(`Goal iteration ${iterationNumber || "<none>"} does not exist.`, { state });
  }
  return iteration;
}

async function readExecutionTodoOrRecordFailure(options: {
  state: GoalLoopState;
  iteration: GoalIterationState;
  todoPath: string;
  store: GoalStateStore;
  previousTraceLength: number;
  now: () => Date;
}): Promise<{ state: GoalLoopState; previousTraceLength: number; content: string }> {
  try {
    const content = await readFile(options.todoPath, "utf8");
    return { state: options.state, previousTraceLength: options.previousTraceLength, content };
  } catch (error) {
    const failure = await recordExecutionFailure({
      state: options.state,
      iteration: options.iteration,
      store: options.store,
      previousTraceLength: options.previousTraceLength,
      message: `Could not read generated TODO ${options.todoPath}: ${errorMessage(error)}`,
      error,
      now: options.now,
    });
    throw new GoalTodoExecutionError(failure.workerResult.summary, {
      cause: error,
      state: failure.state,
      workerResult: failure.workerResult,
    });
  }
}

async function recordExecutionFailure(options: {
  state: GoalLoopState;
  iteration: GoalIterationState;
  store: GoalStateStore;
  previousTraceLength: number;
  message: string;
  error: unknown;
  now: () => Date;
  progressLogPath?: string;
}): Promise<{ state: GoalLoopState; workerResult: GoalWorkerResultState }> {
  const timestamp = options.now().toISOString();
  const workerResult: GoalWorkerResultState = {
    status: "failed",
    summary: options.message,
    todoPath: options.iteration.generatedTodo?.todoPath,
    workerProgressPath: options.progressLogPath,
    error: errorMessage(options.error),
    endedAt: timestamp,
  };
  const state = recordWorkerResult(options.state, options.iteration.iteration, workerResult, { now: options.now() });
  await persistStateChange(options.store, options.previousTraceLength, state);
  const updatedIteration = currentIteration(state, options.iteration.iteration);
  await options.store.writeIterationSnapshot(updatedIteration);
  await options.store.appendIterationResult(updatedIteration);
  return { state, workerResult };
}

function workerResultFromCoordinatorResult(
  childResult: CoordinatorResult,
  progressLogPath: string,
  startedAt: Date,
  endedAt: Date,
): GoalWorkerResultState {
  return {
    status: childResult.status,
    summary: childResult.summary,
    runId: childResult.runId,
    runDir: childResult.runDir,
    todoPath: childResult.todoPath,
    resultPath: childResult.resultPath,
    taskResultPath: childResult.taskResultPath,
    totalTasks: childResult.totalTasks,
    completedTasks: childResult.completedTasks,
    failedTasks: childResult.failedTasks,
    blockedTasks: childResult.blockedTasks,
    workerCostTotal: childResult.workerCostTotal,
    error: childResult.error,
    workerProgressPath: progressLogPath,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
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

async function writeProgressLog(progressLogPath: string, events: CoordinatorProgressUpdate[]): Promise<void> {
  const content = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(progressLogPath, content ? `${content}\n` : "", "utf8");
}

function timeoutForIteration(iteration: GoalIterationState, state: GoalLoopState, now: Date): number {
  if (!iteration.deadlineAt) {
    return state.limits.iterationTimeoutMs;
  }
  const remaining = Date.parse(iteration.deadlineAt) - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 1_000;
  }
  return Math.min(state.limits.iterationTimeoutMs, Math.max(1_000, Math.floor(remaining)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
