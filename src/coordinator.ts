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
import {
  buildTodoCreationPrompt,
  extractTodoMarkdown,
  todoMarkdownFromString,
  validateTodoMarkdown,
} from "./todo_generator.ts";
import { incompleteTasks, markTaskDone, parseTasks, todoGlobalInstructions, type Task } from "./todo_parser.ts";
import {
  createIsolatedWorkerSession,
  lastAssistantTextFromMessages,
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
  maxAttemptsPerTask?: number;
  taskTimeoutMs?: number;
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
  abortSignal?: AbortSignal;
  sessionFactory?: WorkerSessionFactory;
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
  commit: boolean;
  error?: string;
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
  taskThinking: string;
  todoThinking: string;
  workerRunner: WorkerRunner;
  todoPlanner: TodoPlanner;
  abortSignal?: AbortSignal;
  workerSessionFactory?: WorkerSessionFactory;
  todoSessionFactory?: WorkerSessionFactory;
  now: () => Date;
  onProgress?: CoordinatorProgressHandler;
}

export async function runCoordinator(options: RunCoordinatorOptions): Promise<CoordinatorResult> {
  const runtime = buildRuntimeOptions(options);
  const attempts: TaskAttemptSummary[] = [];
  const outcomes: SessionOutcome[] = [];
  const commits: CoordinatorCommitSummary[] = [];

  await mkdir(runtime.runDir, { recursive: true });
  await writeFile(runtime.taskResultPath, initialTaskResultMarkdown(runtime.runId), "utf8");

  try {
    emitProgress(runtime, "Creating TODO plan...", { phase: "planning" });
    let todoMarkdown = await generateOrNormalizeTodoMarkdown(options.inputText, runtime);
    validateTodoMarkdown(todoMarkdown);
    await writeFile(runtime.todoPath, todoMarkdown, "utf8");
    const initialTasks = parseTasks(todoMarkdown);
    emitProgress(runtime, `Created TODO plan with ${initialTasks.length} task(s).`, {
      phase: "planned",
      totalTasks: initialTasks.length,
    });

    const previousAttempts = new Map<string, string[]>();
    let failure: string | undefined;

    while (!runtime.abortSignal?.aborted) {
      const nextTask = incompleteTasks(todoMarkdown)[0];
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
        maxBashTimeoutSeconds: runtime.maxBashTimeoutSeconds,
        taskTimeoutSeconds: runtime.taskTimeoutSeconds,
        thinkingLevel: runtime.taskThinking,
        abortSignal: runtime.abortSignal,
        sessionFactory: runtime.workerSessionFactory,
        now: runtime.now,
        onEvent: (event) => emitWorkerEventProgress(runtime, nextTask, attempt, event),
      });
      outcomes.push(outcome);

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

      emitTaskOutcomeProgress(runtime, nextTask, outcome, taskCommitHash, taskCommitError, taskCommitSkipped);

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
      commit: options.commit,
      error: failure,
    };
    result.message = formatCoordinatorResultMessage(result);
    emitProgress(runtime, `Pi Long Task ${status}.`, {
      phase: "complete",
      status,
      totalTasks: finalTasks.length,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const summary = `Pi Long Task failed: ${message}`;
    try {
      await appendFile(runtime.taskResultPath, `\n## Pi Long Task failure\n\n${message}\n`, "utf8");
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
      commit: options.commit,
      error: message,
    };
    result.message = formatCoordinatorResultMessage(result);
    emitProgress(runtime, "Pi Long Task failed.", { phase: "complete", status: "failed" });
    return result;
  }
}

async function generateOrNormalizeTodoMarkdown(inputText: string, runtime: RuntimeOptions): Promise<string> {
  const local = todoMarkdownFromString(inputText);
  if (local) {
    return local;
  }

  const plannerText = await runtime.todoPlanner({
    inputText,
    cwd: runtime.cwd,
    runDir: runtime.runDir,
    thinkingLevel: runtime.todoThinking,
    abortSignal: runtime.abortSignal,
    sessionFactory: runtime.todoSessionFactory,
  });
  return extractTodoMarkdown(plannerText);
}

export async function runTodoPlanner(options: TodoPlannerOptions): Promise<string> {
  let session: WorkerSessionLike | undefined;
  try {
    const sessionFactory = options.sessionFactory ?? createIsolatedWorkerSession;
    const result = await sessionFactory({
      cwd: options.cwd,
      tools: [],
      thinkingLevel: options.thinkingLevel,
    });
    session = result.session;

    if (options.abortSignal?.aborted) {
      throw new Error("TODO planner aborted before start");
    }

    await session.prompt(buildTodoCreationPrompt(options.inputText));
    const direct = session.getLastAssistantText?.();
    const fromMessages = lastAssistantTextFromMessages(session.messages);
    const text = direct || fromMessages;
    if (!text) {
      throw new Error("TODO planner did not return assistant text.");
    }
    return text;
  } finally {
    session?.dispose?.();
  }
}

function buildRuntimeOptions(options: RunCoordinatorOptions): RuntimeOptions {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runId = sanitizeRunId(options.runId ?? defaultRunId(options.now?.() ?? new Date()));
  const runDir = path.join(cwd, "tmp", "pi-long-task", runId);

  return {
    cwd,
    runId,
    runDir,
    todoPath: path.join(runDir, "TODO.md"),
    taskResultPath: path.join(runDir, "TASK_RESULT.md"),
    maxAttemptsPerTask: positiveInteger(options.maxAttemptsPerTask, DEFAULT_COORDINATOR_OPTIONS.maxAttemptsPerTask),
    taskTimeoutSeconds: positiveMilliseconds(options.taskTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.taskTimeoutMs) / 1000,
    maxBashTimeoutSeconds:
      positiveMilliseconds(options.maxBashTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.maxBashTimeoutMs) / 1000,
    taskThinking: options.taskThinking ?? DEFAULT_COORDINATOR_OPTIONS.taskThinking,
    todoThinking: options.todoThinking ?? DEFAULT_COORDINATOR_OPTIONS.todoThinking,
    workerRunner: options.workerRunner ?? runWorkerTask,
    todoPlanner: options.todoPlanner ?? runTodoPlanner,
    abortSignal: options.abortSignal,
    workerSessionFactory: options.workerSessionFactory,
    todoSessionFactory: options.todoSessionFactory,
    now: options.now ?? (() => new Date()),
    onProgress: options.onProgress,
  };
}

function emitProgress(
  runtime: RuntimeOptions,
  message: string,
  update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath">,
): void {
  runtime.onProgress?.({
    message,
    runId: runtime.runId,
    todoPath: runtime.todoPath,
    resultPath: runtime.taskResultPath,
    ...update,
  });
}

function emitWorkerEventProgress(
  runtime: RuntimeOptions,
  task: Pick<Task, "taskId" | "title">,
  attempt: number,
  event: { type: string; toolName?: string; isError?: boolean },
): void {
  if (!event.toolName || (event.type !== "tool_execution_start" && event.type !== "tool_execution_end")) {
    return;
  }
  const action = event.type === "tool_execution_start" ? "started" : event.isError ? "failed" : "finished";
  const update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath"> = {
    phase: "worker_tool",
    taskId: task.taskId,
    title: task.title,
    attempt,
    status: action,
    toolName: event.toolName,
    workerEventType: event.type,
    isError: event.isError,
  };
  if (event.isError) {
    update.status = "failed";
  }
  emitProgress(runtime, `TODO ${task.taskId}: worker tool ${event.toolName} ${action}.`, update);
}

function emitTaskOutcomeProgress(
  runtime: RuntimeOptions,
  task: Pick<Task, "taskId" | "title">,
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
  const update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath"> = {
    phase,
    taskId: task.taskId,
    title: task.title,
    attempt: outcome.attempt,
    status: outcome.reportedStatus,
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

function initialTaskResultMarkdown(runId: string): string {
  return `# Pi Long Task TASK_RESULT\n\nRun: ${runId}\n`;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
