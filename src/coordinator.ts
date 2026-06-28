import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  CoordinatorCommitSummary,
  CoordinatorRemainingTask,
  CoordinatorStatus,
  PiLongTaskInput,
} from "./types.ts";
import { commitAfterSession, gitDirtyPaths, shouldCommitOutcome, type CommitAfterSessionResult } from "./git.ts";
import { formatCoordinatorResultMessage } from "./render.ts";
import { extractResultSummary } from "./result_writer.ts";
import { runGuardedSessionPrompt } from "./session_guard.ts";
import { parseWorkerRuntimeConfig } from "./worker_config.ts";
import { buildTaskProgressModel, type TaskProgressModel, type TaskProgressStatus } from "./task_progress.ts";
import {
  applyGoalInstructionsToTodoMarkdown,
  buildTodoCreationPrompt,
  buildTodoRepairPrompt,
  extractAndValidateTodoMarkdown,
  TodoGenerationError,
  todoMarkdownFromString,
  validateTodoMarkdown,
} from "./todo_generator.ts";
import { markTaskDone, parseTasks, todoGlobalInstructions, type Task } from "./todo_parser.ts";
import {
  createIsolatedWorkerSession,
  runWorkerTask,
  type RunWorkerTaskOptions,
  type SessionOutcome,
  type WorkerSessionFactory,
  type WorkerSessionLike,
} from "./worker_session.ts";

export type { CoordinatorStatus } from "./types.ts";

export const DEFAULT_COORDINATOR_OPTIONS = {
  maxAttemptsPerTask: 3,
  taskTimeoutMs: 900_000,
  todoTimeoutMs: 300_000,
  todoGracefulShutdownMs: 15_000,
  maxBashTimeoutMs: 300_000,
  taskThinking: "high",
  todoThinking: "xhigh",
} as const;

export type WorkerRunner = (options: RunWorkerTaskOptions) => Promise<SessionOutcome>;
export type CoordinatorProgressPhase =
  | "planning"
  | "planned"
  | "task_start"
  | "worker_tool"
  | "task_done"
  | "task_blocked"
  | "task_failed"
  | "complete";

export type PlannerDiagnosticKind = "timeout" | "abort" | "invalid_output" | "repair_attempt" | "failure";

export interface PlannerDiagnostic {
  kind: PlannerDiagnosticKind;
  message: string;
  diagnostics?: string[];
  sessionFile?: string;
  sessionId?: string;
}

export type PlannerDiagnosticHandler = (diagnostic: PlannerDiagnostic) => void;

export type CoordinatorProgressItemStatus = "empty" | "in_progress" | "done" | "failed" | "blocked";

export interface CoordinatorProgressTask {
  taskId: string;
  title: string;
  status: CoordinatorProgressItemStatus;
}

export interface CoordinatorProgressSubtask {
  text: string;
  status: CoordinatorProgressItemStatus;
}

export interface CoordinatorProgressUpdate {
  message: string;
  phase: CoordinatorProgressPhase;
  runId: string;
  todoPath: string;
  resultPath: string;
  taskId?: string;
  title?: string;
  attempt?: number;
  status?: CoordinatorStatus | string;
  commitHash?: string;
  commitError?: string;
  commitSkipped?: string;
  toolName?: string;
  workerEventType?: string;
  isError?: boolean;
  totalTasks?: number;
  workerCostTotal: number;
  goal?: string;
  currentTask?: CoordinatorProgressTask;
  subtasks?: CoordinatorProgressSubtask[];
  taskProgress?: TaskProgressModel;
  plannerDiagnostic?: PlannerDiagnosticKind;
  plannerDiagnostics?: string[];
  plannerSessionFile?: string;
  plannerSessionId?: string;
}

export type CoordinatorProgressHandler = (update: CoordinatorProgressUpdate) => void;
export type TodoPlanner = (options: TodoPlannerOptions) => Promise<string>;

export interface RunCoordinatorOptions extends PiLongTaskInput {
  cwd?: string;
  runId?: string;
  abortSignal?: AbortSignal;
  workerRunner?: WorkerRunner;
  todoPlanner?: TodoPlanner;
  workerSessionFactory?: WorkerSessionFactory;
  todoSessionFactory?: WorkerSessionFactory;
  workerModel?: unknown;
  workerModelName?: string;
  maxAttemptsPerTask?: number;
  taskTimeoutMs?: number;
  todoTimeoutMs?: number;
  todoGracefulShutdownMs?: number;
  maxBashTimeoutMs?: number;
  taskThinking?: string;
  todoThinking?: string;
  now?: () => Date;
  onProgress?: CoordinatorProgressHandler;
}

export interface TodoPlannerOptions {
  inputText: string;
  cwd: string;
  runDir: string;
  thinkingLevel: string;
  model?: unknown;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  gracefulShutdownMs?: number;
  sessionFactory?: WorkerSessionFactory;
  onDiagnostic?: PlannerDiagnosticHandler;
  goal?: string;
}

export interface TaskAttemptSummary {
  taskId: string;
  title: string;
  attempt: number;
  reportedStatus: string;
  done: boolean;
  error?: string;
  commitHash?: string;
  commitError?: string;
  commitSkipped?: string;
}

export interface CoordinatorResult {
  status: CoordinatorStatus;
  summary: string;
  message: string;
  runId: string;
  runDir: string;
  todoPath: string;
  resultPath: string;
  taskResultPath: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  attemptedTasks: number;
  remainingTasks: CoordinatorRemainingTask[];
  outcomes: SessionOutcome[];
  commits: CoordinatorCommitSummary[];
  attempts: TaskAttemptSummary[];
  taskProgress: TaskProgressModel;
  workerCostTotal: number;
  commit: boolean;
  goal?: string;
  error?: string;
}

interface WorkerCostState {
  total: number;
  finalizedByWorker: Map<string, number>;
  liveByWorker: Map<string, number>;
  liveByMessage: Map<string, number>;
}

interface RuntimeOptions {
  cwd: string;
  runId: string;
  runDir: string;
  todoPath: string;
  taskResultPath: string;
  maxAttemptsPerTask: number;
  taskTimeoutSeconds: number;
  maxBashTimeoutSeconds: number;
  workerModel?: unknown;
  workerModelName?: string;
  goal?: string;
  taskThinking: string;
  todoThinking: string;
  todoTimeoutMs: number;
  todoGracefulShutdownMs: number;
  workerRunner: WorkerRunner;
  todoPlanner: TodoPlanner;
  abortSignal?: AbortSignal;
  workerSessionFactory?: WorkerSessionFactory;
  todoSessionFactory?: WorkerSessionFactory;
  now: () => Date;
  onProgress?: CoordinatorProgressHandler;
  workerCostState: WorkerCostState;
  plannerDiagnostics: PlannerDiagnostic[];
}

export async function runCoordinator(options: RunCoordinatorOptions): Promise<CoordinatorResult> {
  const runtime = buildRuntimeOptions(options);
  const inputText = coordinatorInputText(options);
  const attempts: TaskAttemptSummary[] = [];
  const outcomes: SessionOutcome[] = [];
  const commits: CoordinatorCommitSummary[] = [];

  await mkdir(runtime.runDir, { recursive: true });
  await writeFile(runtime.taskResultPath, initialTaskResultMarkdown(runtime.runId), "utf8");
  let planningComplete = false;

  try {
    emitProgress(runtime, "Creating TODO plan...", { phase: "planning" });
    let todoMarkdown = await generateOrNormalizeTodoMarkdown(inputText, runtime);
    validateTodoMarkdown(todoMarkdown);
    planningComplete = true;
    await writeFile(runtime.todoPath, todoMarkdown, "utf8");
    const initialTasks = parseTasks(todoMarkdown);
    emitProgress(runtime, `Created TODO plan with ${initialTasks.length} task(s).`, {
      phase: "planned",
      totalTasks: initialTasks.length,
      taskProgress: buildTaskProgressModel({ tasks: initialTasks }),
    });

    const previousAttempts = new Map<string, string[]>();
    let failure: string | undefined;

    while (!runtime.abortSignal?.aborted) {
      const tasksBeforeAttempt = parseTasks(todoMarkdown);
      const nextTask = tasksBeforeAttempt.find((task) => !task.done);
      if (!nextTask) {
        break;
      }

      const attempt = (previousAttempts.get(nextTask.taskId)?.length ?? 0) + 1;
      emitProgress(
        runtime,
        `Running TODO ${nextTask.taskId} — ${nextTask.title}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`,
        {
          phase: "task_start",
          taskId: nextTask.taskId,
          title: nextTask.title,
          attempt,
          ...currentTaskProgress(nextTask, "in_progress"),
          taskProgress: buildTaskProgressModel({
            tasks: tasksBeforeAttempt,
            attempts,
            currentTaskId: nextTask.taskId,
          }),
        },
      );
      const preExistingDirtyPaths = options.commit
        ? await gitDirtyPaths(runtime.cwd, runtime.taskResultPath, runtime.todoPath, runtime.runDir)
        : new Set<string>();
      const outcome = await runtime.workerRunner({
        cwd: runtime.cwd,
        todoPath: runtime.todoPath,
        task: nextTask,
        attempt,
        commitRequested: options.commit,
        previousAttempts: previousAttempts.get(nextTask.taskId)?.join("\n\n---\n\n"),
        globalInstructions: todoGlobalInstructions(todoMarkdown),
        goal: runtime.goal,
        maxBashTimeoutSeconds: runtime.maxBashTimeoutSeconds,
        taskTimeoutSeconds: runtime.taskTimeoutSeconds,
        model: runtime.workerModel,
        modelName: runtime.workerModelName,
        thinkingLevel: runtime.taskThinking,
        abortSignal: runtime.abortSignal,
        sessionFactory: runtime.workerSessionFactory,
        now: runtime.now,
        onEvent: (event) => emitWorkerEventProgress(runtime, tasksBeforeAttempt, nextTask, attempts, attempt, event),
      });
      outcomes.push(outcome);
      finalizeWorkerCost(runtime.workerCostState, outcome);

      if (outcome.done) {
        todoMarkdown = markTaskDone(todoMarkdown, nextTask.taskId);
        await writeFile(runtime.todoPath, todoMarkdown, "utf8");
      }

      const attemptDetails: TaskAttemptSummary = {
        taskId: nextTask.taskId,
        title: nextTask.title,
        attempt,
        reportedStatus: outcome.reportedStatus,
        done: outcome.done,
        error: outcome.error,
      };
      attempts.push(attemptDetails);
      await appendTaskResult(runtime.taskResultPath, nextTask, outcome);

      let taskCommitHash: string | undefined;
      let taskCommitError: string | undefined;
      let taskCommitSkipped: string | undefined;
      if (options.commit) {
        const commitResult = shouldCommitOutcome(outcome)
          ? await commitAfterSession({
              cwd: runtime.cwd,
              resultPath: runtime.taskResultPath,
              todoPath: runtime.todoPath,
              runDir: runtime.runDir,
              outcome,
              preExistingDirtyPaths,
            })
          : ({ skipped: "outcome is not eligible for commit" } satisfies CommitAfterSessionResult);
        attemptDetails.commitHash = commitResult.hash;
        attemptDetails.commitError = commitResult.error;
        attemptDetails.commitSkipped = commitResult.skipped;
        if (commitResult.hash || commitResult.error) {
          commits.push({ taskId: nextTask.taskId, hash: commitResult.hash, error: commitResult.error });
        }
        taskCommitHash = commitResult.hash;
        taskCommitError = commitResult.error;
        taskCommitSkipped = commitResult.skipped;
        await appendCommitNote(runtime.taskResultPath, commitResult);
      }

      emitTaskOutcomeProgress(
        runtime,
        parseTasks(todoMarkdown),
        nextTask,
        attempts,
        outcome,
        taskCommitHash,
        taskCommitError,
        taskCommitSkipped,
      );

      const attemptSummary = resultTextForPreviousAttempt(outcome);
      previousAttempts.set(nextTask.taskId, [...(previousAttempts.get(nextTask.taskId) ?? []), attemptSummary]);

      if (outcome.done) {
        continue;
      }

      if (attempt >= runtime.maxAttemptsPerTask) {
        failure = `TODO ${nextTask.taskId} — ${nextTask.title} did not report done after ${attempt} attempt(s).`;
        break;
      }
    }

    if (runtime.abortSignal?.aborted && !failure) {
      failure = "Pi Long Task run aborted.";
    }

    const finalTodoMarkdown = await readFile(runtime.todoPath, "utf8");
    const finalTasks = parseTasks(finalTodoMarkdown);
    const completedTasks = finalTasks.filter((task) => task.done).length;
    const remainingTasks = remainingTaskSummaries(finalTasks, attempts);
    const blockedTasks = remainingTasks.filter((task) => task.status === "blocked").length;
    const failedTasks = remainingTasks.filter(
      (task) => task.status !== "blocked" && task.status !== "not_started",
    ).length;
    const status = deriveCoordinatorStatus({
      failure,
      completedTasks,
      totalTasks: finalTasks.length,
      blockedTasks,
      failedTasks,
    });
    const taskProgress = buildCompletionTaskProgressModel(finalTasks, attempts, status);
    const summary = failure
      ? `Pi Long Task ${status}: ${failure}`
      : `Pi Long Task completed ${completedTasks}/${finalTasks.length} task(s).`;
    const result: CoordinatorResult = {
      status,
      summary,
      message: "",
      runId: runtime.runId,
      runDir: runtime.runDir,
      todoPath: runtime.todoPath,
      resultPath: runtime.taskResultPath,
      taskResultPath: runtime.taskResultPath,
      totalTasks: finalTasks.length,
      completedTasks,
      failedTasks,
      blockedTasks,
      attemptedTasks: attempts.length,
      remainingTasks,
      outcomes,
      commits,
      attempts,
      taskProgress,
      workerCostTotal: runtime.workerCostState.total,
      commit: options.commit,
      goal: runtime.goal,
      error: failure,
    };
    result.message = formatCoordinatorResultMessage(result);
    emitProgress(runtime, `Pi Long Task ${status}.`, {
      phase: "complete",
      status,
      totalTasks: finalTasks.length,
      taskProgress,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    if (!planningComplete) {
      recordPlannerDiagnostic(runtime, {
        kind: "failure",
        message: `TODO planning failed: ${message}`,
      });
    }
    const resultError = !planningComplete
      ? `${message} See ${runtime.taskResultPath} for planner diagnostics.`
      : message;
    const summary = `Pi Long Task failed: ${resultError}`;
    try {
      await appendFailureNote(runtime.taskResultPath, message, !planningComplete ? runtime.plannerDiagnostics : []);
    } catch {
      // Best effort only; the original error is returned below.
    }

    const result: CoordinatorResult = {
      status: "failed",
      summary,
      message: "",
      runId: runtime.runId,
      runDir: runtime.runDir,
      todoPath: runtime.todoPath,
      resultPath: runtime.taskResultPath,
      taskResultPath: runtime.taskResultPath,
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      blockedTasks: 0,
      attemptedTasks: attempts.length,
      remainingTasks: [],
      outcomes,
      commits,
      attempts,
      taskProgress: buildTaskProgressModel({ tasks: [], attempts }),
      workerCostTotal: runtime.workerCostState.total,
      commit: options.commit,
      goal: runtime.goal,
      error: resultError,
    };
    result.message = formatCoordinatorResultMessage(result);
    emitProgress(runtime, "Pi Long Task failed.", {
      phase: "complete",
      status: "failed",
      taskProgress: buildTaskProgressModel({ tasks: [], attempts }),
    });
    return result;
  }
}

async function generateOrNormalizeTodoMarkdown(inputText: string, runtime: RuntimeOptions): Promise<string> {
  const local = todoMarkdownFromString(inputText, runtime.goal);
  if (local) {
    return local;
  }

  const plannerText = await requestTodoPlan(inputText, runtime);
  const planned = await extractTodoMarkdownWithOneRepair(
    inputText,
    plannerText,
    (repairPrompt) => requestTodoPlan(repairPrompt, runtime),
    runtime.goal,
    {
      onInvalidOutput: (validationError) =>
        recordPlannerDiagnostic(runtime, {
          kind: "invalid_output",
          message: `TODO planner returned invalid output: ${validationError}`,
        }),
      onRepairAttempt: (validationError) =>
        recordPlannerDiagnostic(runtime, {
          kind: "repair_attempt",
          message: `Asking TODO planner to repair invalid output: ${validationError}`,
        }),
      onFailure: (validationError) =>
        recordPlannerDiagnostic(runtime, {
          kind: "failure",
          message: `TODO planner repair failed: ${validationError}`,
        }),
    },
  );
  return applyGoalInstructionsToTodoMarkdown(planned, runtime.goal);
}

interface TodoExtractionRepairHooks {
  onInvalidOutput?: (validationError: string) => void;
  onRepairAttempt?: (validationError: string) => void;
  onFailure?: (validationError: string) => void;
}

async function extractTodoMarkdownWithOneRepair(
  inputText: string,
  plannerText: string,
  requestRepair: (repairPrompt: string) => Promise<string>,
  goal?: string,
  hooks: TodoExtractionRepairHooks = {},
): Promise<string> {
  try {
    return extractAndValidateTodoMarkdown(plannerText);
  } catch (error) {
    const validationError = errorMessage(error);
    hooks.onInvalidOutput?.(validationError);
    hooks.onRepairAttempt?.(validationError);
    const repairText = await requestRepair(buildTodoRepairPrompt(inputText, plannerText, validationError, goal));
    try {
      return extractAndValidateTodoMarkdown(repairText);
    } catch (repairError) {
      const repairMessage = errorMessage(repairError);
      hooks.onFailure?.(repairMessage);
      throw new TodoGenerationError(
        `TODO planner returned invalid TODO markdown after one repair attempt: ${repairMessage}`,
      );
    }
  }
}

async function requestTodoPlan(inputText: string, runtime: RuntimeOptions): Promise<string> {
  return runtime.todoPlanner({
    inputText,
    cwd: runtime.cwd,
    runDir: runtime.runDir,
    thinkingLevel: runtime.todoThinking,
    model: runtime.workerModel,
    abortSignal: runtime.abortSignal,
    timeoutMs: runtime.todoTimeoutMs,
    gracefulShutdownMs: runtime.todoGracefulShutdownMs,
    sessionFactory: runtime.todoSessionFactory,
    onDiagnostic: (diagnostic) => recordPlannerDiagnostic(runtime, diagnostic),
    goal: runtime.goal,
  });
}

// Planner/worker lifecycle differences are audited in docs/planner-worker-lifecycle-audit.md;
// keep this function's public contract stable while moving shared prompt guarding into a helper.
export async function runTodoPlanner(options: TodoPlannerOptions): Promise<string> {
  const sessionFactory = options.sessionFactory ?? createIsolatedWorkerSession;
  const result = await sessionFactory({
    cwd: options.cwd,
    tools: [],
    model: options.model,
    thinkingLevel: options.thinkingLevel,
  });
  const session = result.session;
  const timeoutMs = positiveMilliseconds(options.timeoutMs, DEFAULT_COORDINATOR_OPTIONS.todoTimeoutMs);
  const gracefulShutdownMs = options.gracefulShutdownMs ?? DEFAULT_COORDINATOR_OPTIONS.todoGracefulShutdownMs;

  let plannerMarkdown: string | undefined;
  let plannerError: unknown;

  try {
    const plannerText = await runTodoPlannerPrompt({
      session,
      prompt: buildTodoCreationPrompt(options.inputText, options.goal),
      abortSignal: options.abortSignal,
      timeoutMs,
      gracefulShutdownMs,
      diagnostics: result.diagnostics,
      onDiagnostic: options.onDiagnostic,
    });

    plannerMarkdown = await extractTodoMarkdownWithOneRepair(
      options.inputText,
      plannerText,
      (repairPrompt) =>
        runTodoPlannerPrompt({
          session,
          prompt: repairPrompt,
          abortSignal: options.abortSignal,
          timeoutMs,
          gracefulShutdownMs,
          diagnostics: result.diagnostics,
          onDiagnostic: options.onDiagnostic,
        }),
      options.goal,
      {
        onInvalidOutput: (validationError) =>
          options.onDiagnostic?.({
            kind: "invalid_output",
            message: `TODO planner returned invalid output: ${validationError}`,
            diagnostics: result.diagnostics,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
          }),
        onRepairAttempt: (validationError) =>
          options.onDiagnostic?.({
            kind: "repair_attempt",
            message: `Asking TODO planner to repair invalid output: ${validationError}`,
            diagnostics: result.diagnostics,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
          }),
        onFailure: (validationError) =>
          options.onDiagnostic?.({
            kind: "failure",
            message: `TODO planner repair failed: ${validationError}`,
            diagnostics: result.diagnostics,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
          }),
      },
    );
  } catch (error) {
    plannerError = error;
  }

  try {
    await Promise.resolve(session.dispose?.());
  } catch (error) {
    plannerError = plannerError ?? new TodoGenerationError(`TODO planner dispose failed: ${errorMessage(error)}`);
  }

  if (plannerError) {
    throw plannerError;
  }
  if (!plannerMarkdown) {
    throw new TodoGenerationError("TODO planner did not return valid TODO markdown.");
  }
  return applyGoalInstructionsToTodoMarkdown(plannerMarkdown, options.goal);
}

async function runTodoPlannerPrompt(options: {
  session: WorkerSessionLike;
  prompt: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  gracefulShutdownMs: number;
  diagnostics?: string[];
  onDiagnostic?: PlannerDiagnosticHandler;
}): Promise<string> {
  const promptResult = await runGuardedSessionPrompt({
    session: options.session,
    prompt: options.prompt,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    gracefulShutdownMs: options.gracefulShutdownMs,
    gracefulShutdownPrompt: buildTodoPlanningShutdownMessage(),
    diagnostics: options.diagnostics,
    dispose: false,
  });

  if (promptResult.timedOut) {
    const message = `TODO planner timed out: ${promptResult.error ?? "time budget exceeded"}`;
    options.onDiagnostic?.(plannerPromptDiagnostic("timeout", message, promptResult));
    throw new TodoGenerationError(message);
  }
  if (promptResult.aborted) {
    const message = `TODO planner aborted: ${promptResult.error ?? "outer abort signal"}`;
    options.onDiagnostic?.(plannerPromptDiagnostic("abort", message, promptResult));
    throw new TodoGenerationError(message);
  }
  if (promptResult.error) {
    const message = `TODO planner failed: ${promptResult.error}`;
    options.onDiagnostic?.(plannerPromptDiagnostic("failure", message, promptResult));
    throw new TodoGenerationError(message);
  }
  if (!promptResult.assistantText) {
    const message = "TODO planner did not return assistant text.";
    options.onDiagnostic?.(plannerPromptDiagnostic("failure", message, promptResult));
    throw new TodoGenerationError(message);
  }
  return promptResult.assistantText;
}

function plannerPromptDiagnostic(
  kind: Extract<PlannerDiagnosticKind, "timeout" | "abort" | "failure">,
  message: string,
  promptResult: {
    diagnostics: string[];
    sessionFile?: string;
    sessionId?: string;
  },
): PlannerDiagnostic {
  return {
    kind,
    message,
    diagnostics: promptResult.diagnostics,
    sessionFile: promptResult.sessionFile,
    sessionId: promptResult.sessionId,
  };
}

function buildTodoPlanningShutdownMessage(): string {
  return `Pi Long Task notice: TODO planning has reached its time budget.
Return the best valid Pi Long Task TODO markdown you can produce now, or stop if that is not possible.`;
}

function buildRuntimeOptions(options: RunCoordinatorOptions): RuntimeOptions {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runId = sanitizeRunId(options.runId ?? defaultRunId(options.now?.() ?? new Date()));
  const runDir = path.join(cwd, "tmp", "pi-long-task", runId);
  const parsedWorkerConfig = parseWorkerRuntimeConfig(options.inputText ?? "");
  const configuredAttempts = options.maxAttemptsPerTask ?? parsedWorkerConfig.maxAttemptsPerTask;
  const configuredTaskTimeoutMs = options.taskTimeoutMs ?? parsedWorkerConfig.taskTimeoutMs;
  const configuredTodoTimeoutMs = options.todoTimeoutMs;
  const configuredTodoGracefulShutdownMs = options.todoGracefulShutdownMs;
  const configuredMaxBashTimeoutMs = options.maxBashTimeoutMs ?? parsedWorkerConfig.maxBashTimeoutMs;
  const workerModelName = options.workerModelName ?? parsedWorkerConfig.modelName;
  const workerModel = workerModelName ? undefined : options.workerModel;
  const goal = normalizeOptionalText(options.goal);

  return {
    cwd,
    runId,
    runDir,
    todoPath: path.join(runDir, "TODO.md"),
    taskResultPath: path.join(runDir, "TASK_RESULT.md"),
    maxAttemptsPerTask: positiveInteger(configuredAttempts, DEFAULT_COORDINATOR_OPTIONS.maxAttemptsPerTask),
    taskTimeoutSeconds: positiveMilliseconds(configuredTaskTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.taskTimeoutMs) / 1000,
    todoTimeoutMs: positiveMilliseconds(configuredTodoTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.todoTimeoutMs),
    todoGracefulShutdownMs: positiveMilliseconds(
      configuredTodoGracefulShutdownMs,
      DEFAULT_COORDINATOR_OPTIONS.todoGracefulShutdownMs,
    ),
    maxBashTimeoutSeconds:
      positiveMilliseconds(configuredMaxBashTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.maxBashTimeoutMs) / 1000,
    workerModel,
    workerModelName,
    goal,
    taskThinking: options.taskThinking ?? DEFAULT_COORDINATOR_OPTIONS.taskThinking,
    todoThinking: options.todoThinking ?? DEFAULT_COORDINATOR_OPTIONS.todoThinking,
    workerRunner: options.workerRunner ?? runWorkerTask,
    todoPlanner: options.todoPlanner ?? runTodoPlanner,
    abortSignal: options.abortSignal,
    workerSessionFactory: options.workerSessionFactory,
    todoSessionFactory: options.todoSessionFactory,
    now: options.now ?? (() => new Date()),
    onProgress: options.onProgress,
    workerCostState: createWorkerCostState(),
    plannerDiagnostics: [],
  };
}

function emitProgress(
  runtime: RuntimeOptions,
  message: string,
  update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath" | "workerCostTotal">,
): void {
  runtime.onProgress?.({
    message,
    runId: runtime.runId,
    todoPath: runtime.todoPath,
    resultPath: runtime.taskResultPath,
    workerCostTotal: runtime.workerCostState.total,
    ...update,
    goal: runtime.goal,
  });
}

function recordPlannerDiagnostic(runtime: RuntimeOptions, diagnostic: PlannerDiagnostic): void {
  const normalized: PlannerDiagnostic = {
    kind: diagnostic.kind,
    message: diagnostic.message,
    diagnostics: diagnostic.diagnostics?.filter(Boolean),
    sessionFile: diagnostic.sessionFile,
    sessionId: diagnostic.sessionId,
  };
  const last = runtime.plannerDiagnostics.at(-1);
  if (last?.kind === normalized.kind && last.message === normalized.message) {
    return;
  }
  runtime.plannerDiagnostics.push(normalized);
  emitProgress(runtime, normalized.message, {
    phase: "planning",
    status: normalized.kind,
    isError: normalized.kind !== "repair_attempt",
    plannerDiagnostic: normalized.kind,
    plannerDiagnostics: normalized.diagnostics,
    plannerSessionFile: normalized.sessionFile,
    plannerSessionId: normalized.sessionId,
    taskProgress: buildTaskProgressModel({ tasks: [] }),
  });
}

function createWorkerCostState(): WorkerCostState {
  return {
    total: 0,
    finalizedByWorker: new Map(),
    liveByWorker: new Map(),
    liveByMessage: new Map(),
  };
}

function recordLiveWorkerCost(
  state: WorkerCostState,
  worker: string,
  event: { usageCostTotal?: number; usageCostKey?: string },
): boolean {
  if (state.finalizedByWorker.has(worker) || event.usageCostTotal === undefined || !event.usageCostKey) {
    return false;
  }

  const cost = finiteNonNegativeNumber(event.usageCostTotal);
  if (cost === undefined) {
    return false;
  }

  const messageKey = `${worker}:${event.usageCostKey}`;
  if (state.liveByMessage.get(messageKey) === cost) {
    return false;
  }

  state.liveByMessage.set(messageKey, cost);
  recomputeLiveWorkerCost(state, worker);
  recomputeWorkerCostTotal(state);
  return true;
}

function finalizeWorkerCost(
  state: WorkerCostState,
  outcome: Pick<SessionOutcome, "task" | "attempt" | "workerCostTotal">,
): void {
  const worker = workerKey(outcome.task.taskId, outcome.attempt);
  state.finalizedByWorker.set(worker, finiteNonNegativeNumber(outcome.workerCostTotal) ?? 0);
  state.liveByWorker.delete(worker);
  for (const messageKey of state.liveByMessage.keys()) {
    if (messageKey.startsWith(`${worker}:`)) {
      state.liveByMessage.delete(messageKey);
    }
  }
  recomputeWorkerCostTotal(state);
}

function recomputeLiveWorkerCost(state: WorkerCostState, worker: string): void {
  let total = 0;
  for (const [messageKey, cost] of state.liveByMessage) {
    if (messageKey.startsWith(`${worker}:`)) {
      total += cost;
    }
  }
  state.liveByWorker.set(worker, total);
}

function recomputeWorkerCostTotal(state: WorkerCostState): void {
  let total = 0;
  for (const cost of state.finalizedByWorker.values()) {
    total += cost;
  }
  for (const [worker, cost] of state.liveByWorker) {
    if (!state.finalizedByWorker.has(worker)) {
      total += cost;
    }
  }
  state.total = total;
}

function workerKey(taskId: string, attempt: number): string {
  return `${taskId}:${attempt}`;
}

function currentTaskProgress(
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  status: CoordinatorProgressItemStatus,
): Pick<CoordinatorProgressUpdate, "currentTask" | "subtasks"> {
  return {
    currentTask: {
      taskId: task.taskId,
      title: task.title,
      status,
    },
    subtasks: subtaskProgress(task, status),
  };
}

function subtaskProgress(
  task: Pick<Task, "statusItems">,
  taskStatus: CoordinatorProgressItemStatus,
): CoordinatorProgressSubtask[] {
  let markedActive = false;
  return task.statusItems.map((item) => {
    if (item.done || taskStatus === "done") {
      return { text: item.text, status: "done" };
    }
    if ((taskStatus === "in_progress" || taskStatus === "failed" || taskStatus === "blocked") && !markedActive) {
      markedActive = true;
      return { text: item.text, status: taskStatus };
    }
    return { text: item.text, status: "empty" };
  });
}

function emitWorkerEventProgress(
  runtime: RuntimeOptions,
  tasks: readonly Task[],
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  attempts: readonly TaskAttemptSummary[],
  attempt: number,
  event: { type: string; toolName?: string; isError?: boolean; usageCostTotal?: number; usageCostKey?: string },
): void {
  if (event.usageCostTotal !== undefined) {
    const changed = recordLiveWorkerCost(runtime.workerCostState, workerKey(task.taskId, attempt), event);
    if (changed) {
      emitProgress(
        runtime,
        `TODO ${task.taskId}: worker cost updated to ${formatCost(runtime.workerCostState.total)}.`,
        {
          phase: "worker_tool",
          taskId: task.taskId,
          title: task.title,
          attempt,
          status: "in_progress",
          workerEventType: event.type,
          ...currentTaskProgress(task, "in_progress"),
          taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
        },
      );
    }
  }

  if (!event.toolName || (event.type !== "tool_execution_start" && event.type !== "tool_execution_end")) {
    return;
  }
  const action = event.type === "tool_execution_start" ? "started" : event.isError ? "failed" : "finished";
  const update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath" | "workerCostTotal"> = {
    phase: "worker_tool",
    taskId: task.taskId,
    title: task.title,
    attempt,
    status: action,
    toolName: event.toolName,
    workerEventType: event.type,
    isError: event.isError,
    ...currentTaskProgress(task, "in_progress"),
    taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
  };
  if (event.isError) {
    update.status = "failed";
  }
  emitProgress(runtime, `TODO ${task.taskId}: worker tool ${event.toolName} ${action}.`, update);
}

function emitTaskOutcomeProgress(
  runtime: RuntimeOptions,
  tasks: readonly Task[],
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  attempts: readonly TaskAttemptSummary[],
  outcome: SessionOutcome,
  commitHash: string | undefined,
  commitError: string | undefined,
  commitSkipped: string | undefined,
): void {
  const commitText = commitHash
    ? `, commit ${commitHash}`
    : commitError
      ? `, commit failed`
      : commitSkipped
        ? `, commit skipped: ${commitSkipped}`
        : "";
  const statusText = outcome.done ? "done" : outcome.reportedStatus;
  const phase: CoordinatorProgressPhase = outcome.done
    ? "task_done"
    : outcome.reportedStatus === "blocked"
      ? "task_blocked"
      : "task_failed";
  const update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath" | "workerCostTotal"> = {
    phase,
    taskId: task.taskId,
    title: task.title,
    attempt: outcome.attempt,
    status: outcome.reportedStatus,
    ...currentTaskProgress(task, outcomeProgressItemStatus(outcome)),
    taskProgress: buildTaskProgressModel({
      tasks,
      attempts,
      currentTaskId: task.taskId,
      currentTaskStatus: outcomeTaskProgressStatus(outcome),
    }),
  };
  if (commitHash) {
    update.commitHash = commitHash;
  }
  if (commitError) {
    update.commitError = commitError;
  }
  if (commitSkipped) {
    update.commitSkipped = commitSkipped;
  }
  emitProgress(runtime, `TODO ${task.taskId} ${statusText}${commitText}.`, update);
}

function buildCompletionTaskProgressModel(
  tasks: readonly Task[],
  attempts: readonly TaskAttemptSummary[],
  status: CoordinatorStatus,
): TaskProgressModel {
  if (status === "done") {
    return buildTaskProgressModel({ tasks, attempts });
  }

  const lastIncompleteAttempt = [...attempts].reverse().find((attempt) => !attempt.done);
  if (!lastIncompleteAttempt) {
    return buildTaskProgressModel({ tasks, attempts });
  }

  return buildTaskProgressModel({
    tasks,
    attempts,
    currentTaskId: lastIncompleteAttempt.taskId,
    currentTaskStatus: outcomeTaskProgressStatus(lastIncompleteAttempt),
  });
}

function outcomeTaskProgressStatus(outcome: Pick<SessionOutcome, "done" | "reportedStatus">): TaskProgressStatus {
  if (outcome.done) {
    return "completed";
  }
  if (outcome.reportedStatus === "blocked") {
    return "blocked";
  }
  return "failed";
}

function outcomeProgressItemStatus(
  outcome: Pick<SessionOutcome, "done" | "reportedStatus">,
): CoordinatorProgressItemStatus {
  if (outcome.done) {
    return "done";
  }
  if (outcome.reportedStatus === "blocked") {
    return "blocked";
  }
  return "failed";
}

function initialTaskResultMarkdown(runId: string): string {
  return `# Pi Long Task TASK_RESULT\n\nRun: ${runId}\n`;
}

async function appendFailureNote(
  pathname: string,
  message: string,
  plannerDiagnostics: readonly PlannerDiagnostic[],
): Promise<void> {
  const lines = ["", "## Pi Long Task failure", "", message];
  if (plannerDiagnostics.length > 0) {
    lines.push("", "### Planner diagnostics");
    for (const diagnostic of plannerDiagnostics) {
      lines.push("", `- ${diagnostic.kind}: ${diagnostic.message}`);
      if (diagnostic.sessionId) {
        lines.push(`  - Session ID: ${diagnostic.sessionId}`);
      }
      if (diagnostic.sessionFile) {
        lines.push(`  - Session file: ${diagnostic.sessionFile}`);
      }
      for (const item of diagnostic.diagnostics ?? []) {
        lines.push(`  - Diagnostic: ${item}`);
      }
    }
  }
  await appendFile(pathname, `${lines.join("\n")}\n`, "utf8");
}

async function appendCommitNote(pathname: string, result: CommitAfterSessionResult): Promise<void> {
  const lines = ["", "### Commit note", ""];
  if (result.hash) {
    lines.push(`Committed eligible non-artifact changes as \`${result.hash}\`.`);
  } else if (result.error) {
    lines.push(`Commit error: \`${result.error}\``);
  } else {
    lines.push(`Commit skipped: ${result.skipped ?? "no staged diff"}.`);
  }
  await appendFile(pathname, `${lines.join("\n")}\n`, "utf8");
}

async function appendTaskResult(pathname: string, task: Task, outcome: SessionOutcome): Promise<void> {
  const summary = extractResultSummary(outcome.assistantText || "").trim() || "TASK_RESULT:\nstatus: unknown";
  const lines = [
    "",
    `## TODO ${task.taskId} — ${task.title} (attempt ${outcome.attempt})`,
    "",
    `Started: ${outcome.startedAt}`,
    `Ended: ${outcome.endedAt}`,
    `Reported status: ${outcome.reportedStatus}`,
    `Done: ${outcome.done ? "yes" : "no"}`,
  ];

  if (outcome.sessionId) {
    lines.push(`Session ID: ${outcome.sessionId}`);
  }
  if (outcome.sessionFile) {
    lines.push(`Session file: ${outcome.sessionFile}`);
  }
  if (outcome.error) {
    lines.push(`Worker error: ${outcome.error}`);
  }
  if (outcome.timedOut) {
    lines.push("Timed out: yes");
  }
  if (outcome.aborted) {
    lines.push("Aborted: yes");
  }
  if (outcome.contextObservations.length > 0) {
    lines.push("", "Context observations:", ...outcome.contextObservations.map((item) => `- ${item}`));
  }
  if (outcome.compactionEvents.length > 0) {
    lines.push("", "Compaction events:", ...outcome.compactionEvents.map((item) => `- ${item}`));
  }

  lines.push("", "```text", summary, "```", "");
  await appendFile(pathname, `${lines.join("\n")}\n`, "utf8");
}

function remainingTaskSummaries(tasks: Task[], attempts: TaskAttemptSummary[]): CoordinatorRemainingTask[] {
  const lastAttemptByTask = new Map<string, TaskAttemptSummary>();
  for (const attempt of attempts) {
    lastAttemptByTask.set(attempt.taskId, attempt);
  }

  return tasks
    .filter((task) => !task.done)
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: lastAttemptByTask.get(task.taskId)?.reportedStatus ?? "not_started",
    }));
}

function deriveCoordinatorStatus(options: {
  failure: string | undefined;
  completedTasks: number;
  totalTasks: number;
  blockedTasks: number;
  failedTasks: number;
}): CoordinatorStatus {
  if (!options.failure && options.completedTasks === options.totalTasks) {
    return "done";
  }
  if (options.blockedTasks > 0 && options.failedTasks === 0) {
    return "blocked";
  }
  if (options.completedTasks > 0) {
    return "partial";
  }
  return "failed";
}

function resultTextForPreviousAttempt(outcome: SessionOutcome): string {
  const summary = extractResultSummary(outcome.assistantText || "").trim();
  const header = `Attempt ${outcome.attempt}: status=${outcome.reportedStatus}, done=${outcome.done ? "yes" : "no"}`;
  if (outcome.error) {
    return `${header}, error=${outcome.error}\n\n${summary}`.trim();
  }
  return `${header}\n\n${summary}`.trim();
}

function defaultRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function sanitizeRunId(runId: string): string {
  const sanitized = runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || defaultRunId(new Date());
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function coordinatorInputText(options: RunCoordinatorOptions): string {
  return normalizeOptionalText(options.inputText) ?? normalizeOptionalText(options.goal) ?? "";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
