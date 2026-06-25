import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCoordinator, type CoordinatorResult, type RunCoordinatorOptions } from "./coordinator.ts";
import { type GoalIterationState, type GoalLoopState, recordGeneratedTodo, startGoalIteration } from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import { parseTasks } from "./todo_parser.ts";
import { applyGoalInstructionsToTodoMarkdown, extractAndValidateTodoMarkdown } from "./todo_generator.ts";

export const GOAL_TODO_GENERATION_PAYLOAD_FILE = "TODO_GENERATION_TASK.md";
export const GOAL_TODO_GENERATION_RAW_FILE = "GENERATED_TODO_RAW.md";
export const GOAL_TODO_GENERATION_TODO_FILE = "TODO.md";

export type GoalTodoGenerationLongTaskRunner = (options: RunCoordinatorOptions) => Promise<CoordinatorResult>;

export interface GoalTodoGenerationOptions {
  state: GoalLoopState;
  cwd?: string;
  store?: GoalStateStore;
  longTaskRunner?: GoalTodoGenerationLongTaskRunner;
  abortSignal?: AbortSignal;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  maxBashTimeoutMs?: number;
  now?: () => Date;
  additionalContext?: string;
  outputPath?: string;
}

export interface GoalTodoGenerationResult {
  state: GoalLoopState;
  iteration: GoalIterationState;
  todoMarkdown: string;
  todoPath: string;
  rawTodoPath: string;
  payloadPath: string;
  contentHash: string;
  taskCount: number;
  childResult: CoordinatorResult;
}

export class GoalTodoGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalTodoGenerationError";
  }
}

export async function runGoalTodoGenerationLongTask(
  options: GoalTodoGenerationOptions,
): Promise<GoalTodoGenerationResult> {
  const now = options.now ?? (() => new Date());
  let state = options.state;
  let previousTraceLength = state.trace.length;
  const store =
    options.store ?? new GoalStateStore({ cwd: options.cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });

  throwIfAborted(options.abortSignal);
  state = ensurePendingGenerationIteration(state, { now, abortSignal: options.abortSignal });
  await persistStateChange(store, previousTraceLength, state);
  previousTraceLength = state.trace.length;

  const iteration = currentPendingIteration(state);
  const iterationDir = store.iterationDir(iteration.iteration);
  await mkdir(iterationDir, { recursive: true });

  const rawTodoPath = options.outputPath ?? path.join(iterationDir, GOAL_TODO_GENERATION_RAW_FILE);
  const todoPath = path.join(iterationDir, GOAL_TODO_GENERATION_TODO_FILE);
  const payload = buildGoalTodoGenerationTaskPayload({
    state,
    iteration: iteration.iteration,
    outputPath: rawTodoPath,
    additionalContext: options.additionalContext ?? buildPreviousIterationContext(state),
  });
  const payloadPath = path.join(iterationDir, GOAL_TODO_GENERATION_PAYLOAD_FILE);
  await writeFile(payloadPath, payload, "utf8");

  const childResult = await (options.longTaskRunner ?? runCoordinator)({
    inputText: payload,
    commit: false,
    goal: state.goal,
    cwd: options.cwd,
    runId: `${state.goalRunId}-todo-generation-${String(iteration.iteration).padStart(2, "0")}`,
    abortSignal: options.abortSignal,
    workerModel: options.model,
    workerModelName: options.modelName,
    taskThinking: options.thinkingLevel,
    taskTimeoutMs: timeoutForIteration(iteration, state, now()),
    maxBashTimeoutMs: options.maxBashTimeoutMs,
  });

  throwIfAborted(options.abortSignal);
  const rawOutput = await readGeneratedTodo(rawTodoPath, childResult);
  const todoMarkdown = normalizeGeneratedTodoMarkdown(rawOutput, state.goal);
  const taskCount = parseTasks(todoMarkdown).length;
  const contentHash = sha256(todoMarkdown);
  await writeFile(todoPath, todoMarkdown, "utf8");

  state = recordGeneratedTodo(
    state,
    iteration.iteration,
    {
      todoPath,
      summary: `Generated TODO with ${taskCount} task(s).`,
      contentHash,
      payloadPath,
      rawTodoPath,
      generatorRunId: childResult.runId,
      generatorRunDir: childResult.runDir,
      generatorResultPath: childResult.resultPath,
      generatorTaskResultPath: childResult.taskResultPath,
    },
    { now: now() },
  );
  await persistStateChange(store, previousTraceLength, state);
  const updatedIteration = currentIteration(state, iteration.iteration);
  await store.writeIterationSnapshot(updatedIteration);
  await store.appendIterationResult(updatedIteration);

  return {
    state,
    iteration: updatedIteration,
    todoMarkdown,
    todoPath,
    rawTodoPath,
    payloadPath,
    contentHash,
    taskCount,
    childResult,
  };
}

export function buildGoalTodoGenerationTaskPayload(options: {
  state: Pick<GoalLoopState, "goal" | "goalRunId">;
  iteration: number;
  outputPath: string;
  additionalContext?: string;
}): string {
  const context = options.additionalContext?.trim();
  const contextBlock = context ? `\nAdditional iteration context:\n\n${markdownFence(context, "text")}\n` : "";

  return `# Pi Long Task TODO

## Global instructions and constraints

- Long task goal: ${oneLine(options.state.goal)}
- This is goal-loop TODO generation iteration ${options.iteration} for goal run ${options.state.goalRunId}.
- Only generate TODO markdown for future workers; do not implement, edit, test, refactor, or otherwise perform the goal work in this generation run.
- Write the generated Pi Long Task-compatible TODO markdown to \`${options.outputPath}\`.
- Do not wrap the generated file in a code fence and do not include commentary outside the TODO markdown in that file.
- Keep generated tasks focused, independently assignable, and safe for separate worker sessions.

## Progress

- [ ] TODO 1 — Generate Pi Long Task TODO markdown

---

## TODO 1 — Generate Pi Long Task TODO markdown

**Goal:** Convert the high-level goal into a valid Pi Long Task TODO plan for the next implementation long task.

**Status:**
- [ ] Analyze the high-level goal and any iteration context.
- [ ] Create TODO markdown that starts with \`# Pi Long Task TODO\`.
- [ ] Include a \`## Progress\` section with one unchecked \`- [ ] TODO N — Title\` line per generated task.
- [ ] Include a \`---\` separator before generated task sections.
- [ ] Include sequential \`## TODO N — Title\` sections with \`**Goal:**\`, \`**Status:**\`, \`**Verify:**\`, and \`**Done when:**\` guidance.
- [ ] Write only the generated TODO markdown to \`${options.outputPath}\`.

**Verify:**
- Confirm the file at \`${options.outputPath}\` exists.
- Confirm it starts with \`# Pi Long Task TODO\`, has a \`## Progress\` section, a \`---\` separator, sequential TODO sections, unchecked status checkboxes, and concrete verification instructions.

**Done when:**
- \`${options.outputPath}\` contains valid Pi Long Task-compatible TODO markdown for achieving the high-level goal.

High-level goal:

${markdownFence(options.state.goal, "text")}
${contextBlock}`;
}

function ensurePendingGenerationIteration(
  state: GoalLoopState,
  options: { now: () => Date; abortSignal?: AbortSignal },
): GoalLoopState {
  if (state.currentIteration > 0) {
    const current = currentIteration(state, state.currentIteration);
    if (current.status === "pending") {
      return state;
    }
  }
  return startGoalIteration(state, { now: options.now(), abortSignal: options.abortSignal });
}

function currentPendingIteration(state: GoalLoopState): GoalIterationState {
  const iteration = currentIteration(state, state.currentIteration);
  if (iteration.status !== "pending") {
    throw new GoalTodoGenerationError(
      `Goal iteration ${iteration.iteration} is ${iteration.status}; expected pending TODO generation.`,
    );
  }
  return iteration;
}

function currentIteration(state: GoalLoopState, iterationNumber: number): GoalIterationState {
  const iteration = state.iterations.find((item) => item.iteration === iterationNumber);
  if (!iteration) {
    throw new GoalTodoGenerationError(`Goal iteration ${iterationNumber || "<none>"} does not exist.`);
  }
  return iteration;
}

async function persistStateChange(
  store: GoalStateStore,
  previousTraceLength: number,
  state: GoalLoopState,
): Promise<void> {
  await store.saveState(state);
  await store.appendNewTraceEvents(previousTraceLength, state);
}

async function readGeneratedTodo(rawTodoPath: string, childResult: CoordinatorResult): Promise<string> {
  try {
    return await readFile(rawTodoPath, "utf8");
  } catch (error) {
    throw new GoalTodoGenerationError(
      `TODO-generation long task did not write ${rawTodoPath} (child status: ${childResult.status}): ${errorMessage(error)}`,
    );
  }
}

function normalizeGeneratedTodoMarkdown(rawOutput: string, goal: string): string {
  const extracted = extractAndValidateTodoMarkdown(rawOutput);
  return applyGoalInstructionsToTodoMarkdown(extracted, goal);
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

function buildPreviousIterationContext(state: GoalLoopState): string {
  const previous = state.iterations.filter((iteration) => iteration.iteration < state.currentIteration);
  if (previous.length === 0) {
    return "";
  }

  return previous
    .map((iteration) => {
      const lines = [`Iteration ${iteration.iteration}: ${iteration.status}`];
      if (iteration.generatedTodo?.todoPath) {
        lines.push(`Generated TODO: ${iteration.generatedTodo.todoPath}`);
      }
      if (iteration.workerResult) {
        lines.push(`Worker result: ${iteration.workerResult.status} — ${iteration.workerResult.summary}`);
      }
      if (iteration.reviewerResult) {
        lines.push(`Reviewer: ${iteration.reviewerResult.decision} — ${iteration.reviewerResult.rationale}`);
        if (iteration.reviewerResult.remainingWork.length > 0) {
          lines.push("Remaining work:", ...iteration.reviewerResult.remainingWork.map((item) => `- ${item}`));
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function markdownFence(value: string, language: string): string {
  const ticks = longestBacktickRun(value) + 1;
  const fence = "`".repeat(Math.max(3, ticks));
  return `${fence}${language}\n${value.trim()}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GoalTodoGenerationError("TODO generation was aborted before producing a generated TODO.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
