import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PiTodoCoordinatorInput } from "./types.ts";
import { extractResultSummary } from "./result_writer.ts";
import { buildTodoCreationPrompt, extractTodoMarkdown, todoMarkdownFromString, validateTodoMarkdown } from "./todo_generator.ts";
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

export const DEFAULT_COORDINATOR_OPTIONS = {
  maxAttemptsPerTask: 3,
  taskTimeoutMs: 900_000,
  maxBashTimeoutMs: 300_000,
  taskThinking: "high",
  todoThinking: "xhigh",
} as const;

export type CoordinatorStatus = "done" | "failed";
export type WorkerRunner = (options: RunWorkerTaskOptions) => Promise<SessionOutcome>;
export type TodoPlanner = (options: TodoPlannerOptions) => Promise<string>;

export interface RunCoordinatorOptions extends PiTodoCoordinatorInput {
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
}

export interface CoordinatorResult {
  status: CoordinatorStatus;
  summary: string;
  message: string;
  runId: string;
  runDir: string;
  todoPath: string;
  taskResultPath: string;
  totalTasks: number;
  completedTasks: number;
  attemptedTasks: number;
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
}

export async function runCoordinator(options: RunCoordinatorOptions): Promise<CoordinatorResult> {
  const runtime = buildRuntimeOptions(options);
  const attempts: TaskAttemptSummary[] = [];

  await mkdir(runtime.runDir, { recursive: true });
  await writeFile(runtime.taskResultPath, initialTaskResultMarkdown(runtime.runId), "utf8");

  try {
    let todoMarkdown = await generateOrNormalizeTodoMarkdown(options.inputText, runtime);
    validateTodoMarkdown(todoMarkdown);
    await writeFile(runtime.todoPath, todoMarkdown, "utf8");

    const previousAttempts = new Map<string, string[]>();
    let failure: string | undefined;

    while (!runtime.abortSignal?.aborted) {
      const nextTask = incompleteTasks(todoMarkdown)[0];
      if (!nextTask) {
        break;
      }

      const attempt = (previousAttempts.get(nextTask.taskId)?.length ?? 0) + 1;
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
      });

      attempts.push({
        taskId: nextTask.taskId,
        title: nextTask.title,
        attempt,
        reportedStatus: outcome.reportedStatus,
        done: outcome.done,
        error: outcome.error,
      });
      await appendTaskResult(runtime.taskResultPath, nextTask, outcome);

      const attemptSummary = resultTextForPreviousAttempt(outcome);
      previousAttempts.set(nextTask.taskId, [...(previousAttempts.get(nextTask.taskId) ?? []), attemptSummary]);

      if (outcome.done) {
        todoMarkdown = markTaskDone(todoMarkdown, nextTask.taskId);
        await writeFile(runtime.todoPath, todoMarkdown, "utf8");
        continue;
      }

      if (attempt >= runtime.maxAttemptsPerTask) {
        failure = `TODO ${nextTask.taskId} — ${nextTask.title} did not report done after ${attempt} attempt(s).`;
        break;
      }
    }

    if (runtime.abortSignal?.aborted && !failure) {
      failure = "Coordinator run aborted.";
    }

    const finalTodoMarkdown = await readFile(runtime.todoPath, "utf8");
    const finalTasks = parseTasks(finalTodoMarkdown);
    const completedTasks = finalTasks.filter((task) => task.done).length;
    const status: CoordinatorStatus = failure ? "failed" : "done";
    const summary = failure
      ? `Coordinator failed: ${failure}`
      : `Coordinator completed ${completedTasks}/${finalTasks.length} task(s).`;

    return {
      status,
      summary,
      message: summary,
      runId: runtime.runId,
      runDir: runtime.runDir,
      todoPath: runtime.todoPath,
      taskResultPath: runtime.taskResultPath,
      totalTasks: finalTasks.length,
      completedTasks,
      attemptedTasks: attempts.length,
      attempts,
      commit: options.commit,
      error: failure,
    };
  } catch (error) {
    const message = errorMessage(error);
    const summary = `Coordinator failed: ${message}`;
    try {
      await appendFile(runtime.taskResultPath, `\n## Coordinator failure\n\n${message}\n`, "utf8");
    } catch {
      // Best effort only; the original error is returned below.
    }

    return {
      status: "failed",
      summary,
      message: summary,
      runId: runtime.runId,
      runDir: runtime.runDir,
      todoPath: runtime.todoPath,
      taskResultPath: runtime.taskResultPath,
      totalTasks: 0,
      completedTasks: 0,
      attemptedTasks: attempts.length,
      attempts,
      commit: options.commit,
      error: message,
    };
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
  const runDir = path.join(cwd, "tmp", "pi-coordinator", runId);

  return {
    cwd,
    runId,
    runDir,
    todoPath: path.join(runDir, "TODO.md"),
    taskResultPath: path.join(runDir, "TASK_RESULT.md"),
    maxAttemptsPerTask: positiveInteger(options.maxAttemptsPerTask, DEFAULT_COORDINATOR_OPTIONS.maxAttemptsPerTask),
    taskTimeoutSeconds: positiveMilliseconds(options.taskTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.taskTimeoutMs) / 1000,
    maxBashTimeoutSeconds: positiveMilliseconds(options.maxBashTimeoutMs, DEFAULT_COORDINATOR_OPTIONS.maxBashTimeoutMs) / 1000,
    taskThinking: options.taskThinking ?? DEFAULT_COORDINATOR_OPTIONS.taskThinking,
    todoThinking: options.todoThinking ?? DEFAULT_COORDINATOR_OPTIONS.todoThinking,
    workerRunner: options.workerRunner ?? runWorkerTask,
    todoPlanner: options.todoPlanner ?? runTodoPlanner,
    abortSignal: options.abortSignal,
    workerSessionFactory: options.workerSessionFactory,
    todoSessionFactory: options.todoSessionFactory,
    now: options.now ?? (() => new Date()),
  };
}

function initialTaskResultMarkdown(runId: string): string {
  return `# Pi Coordinator TASK_RESULT\n\nRun: ${runId}\n`;
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
