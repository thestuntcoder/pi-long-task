import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cancelGoalLoop,
  type GoalIterationState,
  type GoalLoopState,
  type GoalReviewerDecision,
  type GoalReviewerResultState,
  recordReviewerResult,
} from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import { goalSpecificationToMarkdown, type GoalSpecification } from "./goal_spec.ts";
import {
  assistantTextFromEvent,
  createIsolatedWorkerSession,
  DEFAULT_WORKER_TOOLS,
  lastAssistantTextFromMessages,
  workerUsageCostFromEvent,
  workerUsageCostFromStats,
  type WorkerSessionFactory,
} from "./worker_session.ts";

export const GOAL_REVIEW_PAYLOAD_FILE = "REVIEW_TASK.md";
export const GOAL_REVIEW_RAW_FILE = "REVIEW_RESULT_RAW.txt";

export interface GoalReviewOptions {
  state: GoalLoopState;
  cwd?: string;
  store?: GoalStateStore;
  reviewerRunner?: GoalReviewerRunner;
  abortSignal?: AbortSignal;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  now?: () => Date;
  sessionFactory?: WorkerSessionFactory;
  goalSpecification?: GoalSpecification;
}

export interface GoalReviewResult {
  state: GoalLoopState;
  iteration: GoalIterationState;
  payload: string;
  payloadPath: string;
  rawReviewPath: string;
  rawReviewerOutput: string;
  reviewerResult: GoalReviewerResultState;
  sessionResult: GoalReviewerSessionResult;
}

export interface GoalReviewerRunnerOptions {
  prompt: string;
  cwd: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  sessionFactory?: WorkerSessionFactory;
}

export interface GoalReviewerSessionResult {
  assistantText: string;
  reviewerSessionId?: string;
  reviewerSessionFile?: string;
  reviewerCostTotal?: number;
  timedOut?: boolean;
  aborted?: boolean;
  error?: string;
}

export type GoalReviewerRunner = (options: GoalReviewerRunnerOptions) => Promise<GoalReviewerSessionResult>;

export class GoalReviewError extends Error {
  readonly state: GoalLoopState | undefined;
  readonly reviewerResult: GoalReviewerResultState | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; state?: GoalLoopState; reviewerResult?: GoalReviewerResultState } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GoalReviewError";
    this.state = options.state;
    this.reviewerResult = options.reviewerResult;
  }
}

export async function runGoalReviewSession(options: GoalReviewOptions): Promise<GoalReviewResult> {
  const now = options.now ?? (() => new Date());
  let state = options.state;
  const previousTraceLength = state.trace.length;
  const store =
    options.store ?? new GoalStateStore({ cwd: options.cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });

  const iteration = currentReviewableIteration(state);
  const iterationDir = store.iterationDir(iteration.iteration);
  await mkdir(iterationDir, { recursive: true });
  const payloadPath = path.join(iterationDir, GOAL_REVIEW_PAYLOAD_FILE);
  const rawReviewPath = path.join(iterationDir, GOAL_REVIEW_RAW_FILE);
  const goalSpecification = options.goalSpecification ?? (await store.tryLoadGoalSpecification());
  const payload = buildGoalReviewTaskPayload({
    state,
    iteration,
    goalSpecification,
    goalSpecificationPath: goalSpecification ? store.paths.goalSpecPath : undefined,
  });
  await writeFile(payloadPath, payload, "utf8");

  if (options.abortSignal?.aborted) {
    state = cancelGoalLoop(state, "Goal review was aborted before starting.", { now: now() });
    await persistStateChange(store, previousTraceLength, state);
    await store.writeIterationSnapshot(currentIteration(state, iteration.iteration));
    throw new GoalReviewError("Goal review was aborted before starting.", { state });
  }

  let sessionResult: GoalReviewerSessionResult;
  try {
    sessionResult = await (options.reviewerRunner ?? runGoalReviewerSession)({
      prompt: payload,
      cwd: path.resolve(options.cwd ?? process.cwd()),
      abortSignal: options.abortSignal,
      timeoutMs: state.limits.reviewerTimeoutMs,
      model: options.model,
      modelName: options.modelName,
      thinkingLevel: options.thinkingLevel,
      sessionFactory: options.sessionFactory,
    });
  } catch (error) {
    const failure = await recordReviewFailure({
      state,
      iteration,
      store,
      previousTraceLength,
      payloadPath,
      rawReviewPath,
      message: `Reviewer session failed: ${errorMessage(error)}`,
      error,
      now,
    });
    throw new GoalReviewError(failure.reviewerResult.summary, {
      cause: error,
      state: failure.state,
      reviewerResult: failure.reviewerResult,
    });
  }

  const rawReviewerOutput = sessionResult.assistantText;
  await writeFile(rawReviewPath, rawReviewerOutput, "utf8");

  let reviewerResult: GoalReviewerResultState;
  try {
    reviewerResult = {
      ...parseGoalReviewerOutput(rawReviewerOutput, { now: now() }),
      reviewerSessionId: sessionResult.reviewerSessionId,
      reviewerSessionFile: sessionResult.reviewerSessionFile,
      payloadPath,
      rawReviewPath,
      reviewerCostTotal: sessionResult.reviewerCostTotal,
    };
  } catch (error) {
    const failure = await recordReviewFailure({
      state,
      iteration,
      store,
      previousTraceLength,
      payloadPath,
      rawReviewPath,
      message: `Reviewer output could not be parsed: ${errorMessage(error)}`,
      error,
      rawReviewerOutput,
      sessionResult,
      now,
    });
    throw new GoalReviewError(failure.reviewerResult.summary, {
      cause: error,
      state: failure.state,
      reviewerResult: failure.reviewerResult,
    });
  }

  reviewerResult = enforceMinimumIterationsBeforeCompletion(reviewerResult, state, iteration.iteration);

  state = recordReviewerResult(state, iteration.iteration, reviewerResult, { now: now() });
  await persistStateChange(store, previousTraceLength, state);
  const updatedIteration = currentIteration(state, iteration.iteration);
  await store.writeIterationSnapshot(updatedIteration);
  await store.appendIterationResult(updatedIteration);

  return {
    state,
    iteration: updatedIteration,
    payload,
    payloadPath,
    rawReviewPath,
    rawReviewerOutput,
    reviewerResult,
    sessionResult,
  };
}

export function buildGoalReviewTaskPayload(options: {
  state: GoalLoopState;
  iteration: GoalIterationState;
  goalSpecification?: GoalSpecification;
  goalSpecificationPath?: string;
}): string {
  const { state, iteration } = options;
  const workerResult = iteration.workerResult;
  const generatedTodo = iteration.generatedTodo;
  const previousContext = previousReviewContext(state, iteration.iteration);
  const previousContextBlock = previousContext
    ? `\nPrevious iteration review context:\n\n${markdownFence(previousContext, "text")}\n`
    : "";
  const specificationBlock = options.goalSpecification
    ? `\nPersisted goal specification (primary review target):\n\n${markdownFence(
        buildGoalSpecificationReviewContext(options.goalSpecification, options.goalSpecificationPath),
        "markdown",
      )}\n`
    : "";
  const reviewTargetInstruction = options.goalSpecification
    ? "Review whether the latest worker run satisfies the persisted goal specification and definition-of-done. Treat the persisted specification as the primary review target; keep the original high-level goal available only as traceability/context."
    : "Review whether the original high-level goal is complete after the latest worker run.";
  const iterationPolicy = `Goal loop iteration policy:
- Current iteration: ${iteration.iteration}
- Minimum iterations before completion may stop the loop: ${state.limits.minIterations}
- Maximum iterations: ${state.limits.maxIterations}
- If current iteration is below the minimum, do not return "complete" even if the current implementation looks good. Return "incomplete" with concrete remainingWork for the next improvement pass, such as missing verification, hardening, UX polish, security, performance, docs, edge cases, or maintainability follow-up.`;
  const decisionRules = options.goalSpecification
    ? `- Use "complete" only when the persisted definition-of-done is satisfied, including in-scope requirements, milestones, acceptance criteria, required verification gates, and applicable design/product constraints.
- Use "incomplete" when any required spec requirement, milestone, acceptance criterion, verification gate, artifact, or constraint still needs work and another TODO-generation iteration should be started.
- Use "blocked" when a required spec item cannot be evaluated or completed without external input or unavailable resources.
- Use "failed" when the loop should stop because the run is unrecoverably failed.
- In summary, rationale, and remainingWork, cite specific spec IDs or named criteria where applicable (for example REQ-*, MS-*, AC-*, VG-*).`
    : `- Use "complete" only when the original high-level goal is satisfied, not merely when the worker finished its TODO.
- Use "incomplete" when meaningful work remains and another TODO-generation iteration should be started.
- Use "blocked" when external input or unavailable resources prevent progress.
- Use "failed" when the loop should stop because the run is unrecoverably failed.`;

  return `You are a separate Pi SDK reviewer session for a goal-oriented long-task loop.

${reviewTargetInstruction} Do not implement fixes, edit files, or commit. You may inspect files and run focused read-only verification commands when useful.

Original high-level goal:

${markdownFence(state.goal, "text")}
${specificationBlock}
Goal run: ${state.goalRunId}
Iteration: ${iteration.iteration}
Generated TODO path: ${generatedTodo?.todoPath ?? "unknown"}

${iterationPolicy}
Worker result:

${markdownFence(JSON.stringify(workerResult ?? null, null, 2), "json")}
${previousContextBlock}
Decision rules:
${decisionRules}

Reply with only one JSON object, with no Markdown fence or commentary, matching this schema:
{
  "decision": "complete" | "incomplete" | "blocked" | "failed",
  "complete": boolean,
  "summary": "short reviewer summary",
  "rationale": "why the goal is or is not complete",
  "remainingWork": ["specific remaining item", "..."]
}`;
}

export function parseGoalReviewerOutput(
  output: string,
  options: { now?: Date } = {},
): Omit<GoalReviewerResultState, "reviewerSessionId" | "reviewerSessionFile"> {
  const parsed = parseJsonObjectFromText(output);
  const decision = normalizeDecision(parsed.decision, parsed.complete);
  const complete = decision === "complete";
  const summary = stringField(parsed.summary) || defaultSummary(decision);
  const rationale = stringField(parsed.rationale) || stringField(parsed.reason) || summary;
  const remainingWork = stringArrayField(parsed.remainingWork ?? parsed.remaining ?? parsed.remaining_items);
  return {
    decision,
    complete,
    summary,
    rationale,
    remainingWork: complete ? [] : remainingWork,
    reviewedAt: (options.now ?? new Date()).toISOString(),
  };
}

function enforceMinimumIterationsBeforeCompletion(
  result: GoalReviewerResultState,
  state: GoalLoopState,
  iteration: number,
): GoalReviewerResultState {
  if (result.decision !== "complete" && !result.complete) {
    return result;
  }
  if (iteration >= state.limits.minIterations) {
    return result;
  }

  const remainingIterations = Math.max(1, state.limits.minIterations - iteration);
  const remainingWork = result.remainingWork.length > 0 ? result.remainingWork : minimumIterationRemainingWork(state);
  return {
    ...result,
    decision: "incomplete",
    complete: false,
    summary: `Minimum iteration target not reached (${iteration}/${state.limits.minIterations}); continuing goal loop.`,
    rationale: `${result.rationale}\n\nReviewer completion was deferred because this goal loop requires at least ${state.limits.minIterations} iteration(s) before it may stop. ${remainingIterations} more iteration(s) are required, so the next pass should look for concrete improvements, hardening, verification, and polish rather than stopping early.`,
    remainingWork,
  };
}

function minimumIterationRemainingWork(state: GoalLoopState): string[] {
  return [
    `Continue toward the required minimum of ${state.limits.minIterations} goal-loop iterations before accepting completion.`,
    "Run another pass focused on gaps the previous TODO did not cover: verification depth, edge cases, security, performance, UX polish, documentation, maintainability, and product completeness.",
    "Generate concrete implementation or review tasks from the persisted goal specification and latest evidence instead of stopping after the first apparently complete pass.",
  ];
}

export async function runGoalReviewerSession(options: GoalReviewerRunnerOptions): Promise<GoalReviewerSessionResult> {
  const sessionFactory = options.sessionFactory ?? createIsolatedWorkerSession;
  const events: unknown[] = [];
  let assistantText = "";
  let timedOut = false;
  let aborted = false;
  let error: string | undefined;
  let reviewerCostTotal = 0;
  let session: Awaited<ReturnType<typeof sessionFactory>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const abortSession = async (reason: string) => {
    if (!session || aborted) {
      return;
    }
    aborted = true;
    error = error ?? reason;
    await session.abort?.();
  };
  const abortListener = () => {
    void abortSession("reviewer session aborted by outer signal").catch((exc: unknown) => {
      error = error ?? errorMessage(exc);
    });
  };

  try {
    if (options.abortSignal?.aborted) {
      throw new Error("reviewer session aborted before start");
    }
    const factoryResult = await sessionFactory({
      cwd: options.cwd,
      tools: DEFAULT_WORKER_TOOLS,
      model: options.model,
      modelName: options.modelName,
      thinkingLevel: options.thinkingLevel,
    });
    session = factoryResult.session;
    unsubscribe = session.subscribe((event: unknown) => {
      events.push(event);
      const text = assistantTextFromEvent(event);
      if (text) {
        assistantText = text;
      }
      const cost = workerUsageCostFromEvent(event);
      if (cost !== undefined) {
        reviewerCostTotal = Math.max(reviewerCostTotal, cost);
      }
    });
    options.abortSignal?.addEventListener("abort", abortListener, { once: true });
    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        void abortSession(`reviewer exceeded ${options.timeoutMs}ms timeout`).catch((exc: unknown) => {
          error = error ?? errorMessage(exc);
        });
      }, options.timeoutMs);
    }
    await session.prompt(options.prompt);
    assistantText = latestAssistantText(session, assistantText);
  } catch (exc) {
    error = error ?? errorMessage(exc);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.abortSignal?.removeEventListener("abort", abortListener);
    unsubscribe?.();
    if (session) {
      assistantText = latestAssistantText(session, assistantText);
      const statsCost = session.getSessionStats ? workerUsageCostFromStats(await session.getSessionStats()) : undefined;
      if (statsCost !== undefined) {
        reviewerCostTotal = statsCost;
      }
      session.dispose?.();
    }
  }

  return {
    assistantText,
    reviewerSessionId: session?.sessionId,
    reviewerSessionFile: session?.sessionFile,
    reviewerCostTotal,
    timedOut,
    aborted: aborted || Boolean(options.abortSignal?.aborted),
    error,
  };
}

function currentReviewableIteration(state: GoalLoopState): GoalIterationState {
  const iteration = currentIteration(state, state.currentIteration);
  if (iteration.status !== "todo_executed" && iteration.status !== "failed") {
    throw new GoalReviewError(
      `Goal iteration ${iteration.iteration} is ${iteration.status}; expected worker result review.`,
      {
        state,
      },
    );
  }
  return iteration;
}

function currentIteration(state: GoalLoopState, iterationNumber: number): GoalIterationState {
  const iteration = state.iterations.find((item) => item.iteration === iterationNumber);
  if (!iteration) {
    throw new GoalReviewError(`Goal iteration ${iterationNumber || "<none>"} does not exist.`, { state });
  }
  return iteration;
}

async function recordReviewFailure(options: {
  state: GoalLoopState;
  iteration: GoalIterationState;
  store: GoalStateStore;
  previousTraceLength: number;
  payloadPath: string;
  rawReviewPath: string;
  message: string;
  error: unknown;
  rawReviewerOutput?: string;
  sessionResult?: GoalReviewerSessionResult;
  now: () => Date;
}): Promise<{ state: GoalLoopState; reviewerResult: GoalReviewerResultState }> {
  if (options.rawReviewerOutput !== undefined) {
    await writeFile(options.rawReviewPath, options.rawReviewerOutput, "utf8");
  }
  const timestamp = options.now().toISOString();
  const reviewerResult: GoalReviewerResultState = {
    decision: "failed",
    complete: false,
    summary: options.message,
    rationale: options.message,
    remainingWork: [],
    reviewerSessionId: options.sessionResult?.reviewerSessionId,
    reviewerSessionFile: options.sessionResult?.reviewerSessionFile,
    payloadPath: options.payloadPath,
    rawReviewPath: options.rawReviewPath,
    reviewerCostTotal: options.sessionResult?.reviewerCostTotal,
    error: errorMessage(options.error),
    reviewedAt: timestamp,
  };
  const state = recordReviewerResult(options.state, options.iteration.iteration, reviewerResult, {
    now: options.now(),
  });
  await persistStateChange(options.store, options.previousTraceLength, state);
  const updatedIteration = currentIteration(state, options.iteration.iteration);
  await options.store.writeIterationSnapshot(updatedIteration);
  await options.store.appendIterationResult(updatedIteration);
  return { state, reviewerResult };
}

async function persistStateChange(
  store: GoalStateStore,
  previousTraceLength: number,
  state: GoalLoopState,
): Promise<void> {
  await store.saveState(state);
  await store.appendNewTraceEvents(previousTraceLength, state);
}

function buildGoalSpecificationReviewContext(spec: GoalSpecification, goalSpecificationPath?: string): string {
  return [
    `Goal spec path: ${goalSpecificationPath ?? "<not provided>"}`,
    "",
    goalSpecificationToMarkdown(spec).trim(),
    "",
    "Reviewer evaluation instructions:",
    "- Treat this persisted specification as the source of truth for final evaluation.",
    "- Check in-scope requirements, milestones, acceptance criteria, required verification gates, required artifacts, and design/product constraints before deciding complete.",
    "- Use the original user goal only as traceability context when interpreting the specification.",
    "- Cite specific spec IDs or named criteria in rationale and remainingWork whenever a criterion is satisfied, missing, blocked, or not applicable.",
  ].join("\n");
}

function previousReviewContext(state: GoalLoopState, currentIterationNumber: number): string {
  return state.iterations
    .filter((iteration) => iteration.iteration < currentIterationNumber)
    .map((iteration) => {
      const lines = [`Iteration ${iteration.iteration}: ${iteration.status}`];
      if (iteration.workerResult) {
        lines.push(`Worker: ${iteration.workerResult.status} — ${iteration.workerResult.summary}`);
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

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new GoalReviewError("Reviewer output was empty.");
  }

  for (const candidate of jsonCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new GoalReviewError("Reviewer output did not contain a JSON object.");
}

function jsonCandidates(text: string): string[] {
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  return candidates;
}

function normalizeDecision(decisionValue: unknown, completeValue: unknown): GoalReviewerDecision {
  const decision = typeof decisionValue === "string" ? decisionValue.trim().toLowerCase() : "";
  if (decision === "complete" || decision === "incomplete" || decision === "blocked" || decision === "failed") {
    return decision;
  }
  if (typeof completeValue === "boolean") {
    return completeValue ? "complete" : "incomplete";
  }
  throw new GoalReviewError("Reviewer JSON must include decision or complete.");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function defaultSummary(decision: GoalReviewerDecision): string {
  switch (decision) {
    case "complete":
      return "Reviewer confirmed the goal is complete.";
    case "incomplete":
      return "Reviewer found remaining work.";
    case "blocked":
      return "Reviewer found the goal is blocked.";
    case "failed":
      return "Reviewer found the goal loop failed.";
  }
}

function latestAssistantText(
  session: { getLastAssistantText?: () => string | undefined; messages?: unknown[] },
  fallback: string,
): string {
  return session.getLastAssistantText?.() || lastAssistantTextFromMessages(session.messages) || fallback;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
