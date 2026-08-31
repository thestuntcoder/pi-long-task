import type { PlanRevisionResult, PlanTaskState, ReconciledPlanTask } from "./plan_revision.ts";
import { reconcilePlanRevision } from "./plan_revision.ts";
import { parseTasks, type Task } from "./todo_parser.ts";
import { extractAndValidateTodoMarkdown, validateTodoMarkdown } from "./todo_generator.ts";

export interface PlanRevisionRelevantResult {
  /** Task ID in the current (pre-revision) plan. */
  taskId: string;
  status: string;
  summary: string;
  outputReferences?: readonly string[];
}

export interface PlanRevisionActiveTaskContext {
  taskId: string;
  title: string;
  attempt?: number;
  startedAt?: string;
  activity?: string;
}

export interface PlanRevisionRequest {
  revisionId: string;
  guidance: string;
  currentTodoMarkdown: string;
  taskStates: Readonly<Record<string, PlanTaskState>>;
  relevantResults: readonly PlanRevisionRelevantResult[];
  activeTask?: PlanRevisionActiveTaskContext;
  invalidatedTaskIds: readonly string[];
}

export interface PlanRevisionPlannerInput {
  /** Ready-to-send planner prompt containing the complete revision context. */
  prompt: string;
  /** Structured form of the same context for planner adapters that do not consume a text prompt. */
  request: Readonly<PlanRevisionRequest>;
}

export type PlanRevisionPlanner = (input: PlanRevisionPlannerInput) => Promise<string>;

export interface PreservedPlanRevisionResult {
  previousTaskId: string;
  identity: string;
  retainedAs: "active" | "history";
  result: PlanRevisionRelevantResult;
}

export interface GeneratedPlanRevision {
  revisionId: string;
  guidance: string;
  /** Valid planner proposal before coordinator-owned state is applied. */
  proposalMarkdown: string;
  /** Complete, valid TODO markdown with reconciled task identity and completion state. */
  todoMarkdown: string;
  reconciliation: PlanRevisionResult;
  preservedResults: PreservedPlanRevisionResult[];
}

export interface GeneratePlanRevisionOptions {
  currentTodoMarkdown: string;
  guidance: string;
  revisionId: string;
  planner: PlanRevisionPlanner;
  taskStates?: Readonly<Record<string, PlanTaskState>>;
  relevantResults?: readonly PlanRevisionRelevantResult[];
  activeTask?: PlanRevisionActiveTaskContext;
  invalidatedTaskIds?: readonly string[];
}

/**
 * A failed revision is recoverable: callers must keep priorTodoMarkdown as the
 * authoritative plan and may retry the same queued guidance.
 */
export class PlanRevisionGenerationError extends Error {
  readonly recoverable = true;
  readonly priorTodoMarkdown: string;
  readonly revisionId: string;

  constructor(message: string, options: { priorTodoMarkdown: string; revisionId: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "PlanRevisionGenerationError";
    this.priorTodoMarkdown = options.priorTodoMarkdown;
    this.revisionId = options.revisionId;
  }
}

/**
 * Requests a complete revised plan, validates it, and reconciles it without
 * mutating or persisting the current plan. A caller should replace its active
 * snapshot only after this function resolves.
 */
export async function generatePlanRevision(options: GeneratePlanRevisionOptions): Promise<GeneratedPlanRevision> {
  const priorTodoMarkdown = options.currentTodoMarkdown;
  const revisionId = options.revisionId.trim();
  const guidance = options.guidance.trim();

  try {
    if (!revisionId) {
      throw new Error("A plan revision requires a non-empty revisionId.");
    }
    if (!guidance) {
      throw new Error("Plan revision guidance must not be empty.");
    }

    validateTodoMarkdown(priorTodoMarkdown);
    const previousTasks = parseTasks(priorTodoMarkdown);
    const taskStates = effectiveTaskStates(previousTasks, options.taskStates, options.activeTask);
    const request: PlanRevisionRequest = {
      revisionId,
      guidance,
      currentTodoMarkdown: priorTodoMarkdown,
      taskStates,
      relevantResults: (options.relevantResults ?? []).map(copyRelevantResult),
      activeTask: options.activeTask ? { ...options.activeTask } : undefined,
      invalidatedTaskIds: [...(options.invalidatedTaskIds ?? [])],
    };
    const prompt = buildPlanRevisionPrompt(request);
    const rawProposal = await options.planner({ prompt, request });
    const proposalMarkdown = extractAndValidateTodoMarkdown(rawProposal);
    // Keep this explicit even though extraction validates. It guards future
    // extractor changes before any accepted state can be returned.
    validateTodoMarkdown(proposalMarkdown);
    const revisedTasks = parseTasks(proposalMarkdown);
    const reconciliation = reconcilePlanRevision(previousTasks, revisedTasks, {
      previousStates: taskStates,
      runningTaskId: options.activeTask?.taskId,
      invalidatedTaskIds: request.invalidatedTaskIds,
      revisionId,
    });
    const todoMarkdown = renderReconciledTodoMarkdown(proposalMarkdown, reconciliation.activeTasks);
    validateTodoMarkdown(todoMarkdown);
    const renderedTasks = parseTasks(todoMarkdown);
    const renderedReconciliation = reconciliationWithRenderedTasks(reconciliation, renderedTasks);

    return {
      revisionId,
      guidance,
      proposalMarkdown,
      todoMarkdown,
      reconciliation: renderedReconciliation,
      preservedResults: preservedRevisionResults(previousTasks, renderedReconciliation, request.relevantResults),
    };
  } catch (error) {
    if (error instanceof PlanRevisionGenerationError) {
      throw error;
    }
    throw new PlanRevisionGenerationError(
      `Plan revision ${revisionId || "<unknown>"} was not accepted: ${errorMessage(error)}`,
      {
        priorTodoMarkdown,
        revisionId,
        cause: error,
      },
    );
  }
}

/** Builds the complete planner context required to place steering guidance. */
export function buildPlanRevisionPrompt(request: Readonly<PlanRevisionRequest>): string {
  const taskContext = parseTasks(request.currentTodoMarkdown).map((task) => ({
    taskId: task.taskId,
    stableId: task.stableId,
    title: task.title,
    state: request.taskStates[task.taskId] ?? (task.done ? "completed" : "pending"),
  }));
  const activeTask = request.activeTask ?? null;

  return `Revise an active Pi Long Task TODO plan using new steering guidance.

Return one complete, valid revised plan. Output only markdown, without commentary or a code fence.

Required format and revision rules:
- Start with exactly \`# Pi Long Task TODO\`.
- Include a \`## Progress\` section with exactly one \`- [ ] TODO N — Title\` or \`- [x] TODO N — Title\` line per task.
- Include a \`---\` separator, then sequential \`## TODO N — Title\` sections.
- Every task must include \`**Goal:**\`, \`**Status:**\` with checkbox items, \`**Verify:**\`, and \`**Done when:**\`.
- Apply the guidance where it belongs and revise only affected plan content. Preserve unrelated tasks and global constraints.
- Preserve the relative order of unaffected tasks unless the guidance requests a reorder.
- Preserve each \`<!-- pi-long-task-id: ... -->\` marker on equivalent existing work. New tasks may omit the marker.
- Do not use checkbox changes to discard coordinator-owned status. The coordinator will reconcile status after validation.
- Never silently rewrite or erase completed history. If guidance corrects completed work, retain its valid result and express the new requirement as explicit follow-up work.
- Return the full plan, not a patch, diff, explanation, or partial task section.

Revision ID: ${oneLine(request.revisionId)}

Coordinator-owned task state:

${markdownFence(JSON.stringify(taskContext, null, 2), "json")}

Active-task context:

${markdownFence(JSON.stringify(activeTask, null, 2), "json")}

Relevant completed/attempt results and output references:

${markdownFence(JSON.stringify(request.relevantResults, null, 2), "json")}

Explicitly invalidated current task IDs:

${markdownFence(JSON.stringify(request.invalidatedTaskIds), "json")}

New steering guidance:

${markdownFence(request.guidance, "text")}

Current complete TODO plan:

${markdownFence(request.currentTodoMarkdown, "markdown")}
`;
}

/**
 * Produces a normal Pi Long Task TODO document from reconciled active items.
 * Persistence and atomic replacement are intentionally left to the caller.
 */
export function renderReconciledTodoMarkdown(
  proposedMarkdown: string,
  activeTasks: readonly ReconciledPlanTask[],
): string {
  if (activeTasks.length === 0) {
    throw new Error("A revised TODO plan must retain at least one active or historical-completion task.");
  }

  const normalized = proposedMarkdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const progressIndex = lines.findIndex((line) => /^##\s+Progress\s*$/i.test(line.trim()));
  if (progressIndex < 0) {
    throw new Error("The revised TODO plan is missing its Progress section.");
  }
  const prefix = lines.slice(0, progressIndex).join("\n").trimEnd();
  const progress = activeTasks
    .map((item, index) => `- [${item.state === "completed" ? "x" : " "}] TODO ${index + 1} — ${item.task.title}`)
    .join("\n");
  const sections = activeTasks
    .map((item, index) => renumberTaskSection(item.task.section, index + 1, item.task.title))
    .join("\n\n");
  const rendered = `${prefix}\n\n## Progress\n\n${progress}\n\n---\n\n${sections.trimEnd()}\n`;
  validateTodoMarkdown(rendered);
  return rendered;
}

function effectiveTaskStates(
  tasks: readonly Task[],
  supplied: Readonly<Record<string, PlanTaskState>> | undefined,
  activeTask: PlanRevisionActiveTaskContext | undefined,
): Readonly<Record<string, PlanTaskState>> {
  const knownIds = new Set(tasks.map((task) => task.taskId));
  for (const taskId of Object.keys(supplied ?? {})) {
    if (!knownIds.has(taskId)) {
      throw new Error(`Task state refers to unknown current TODO ${taskId}.`);
    }
  }
  if (activeTask && !knownIds.has(activeTask.taskId)) {
    throw new Error(`Active task TODO ${activeTask.taskId} is not present in the current plan.`);
  }

  return Object.fromEntries(
    tasks.map((task) => {
      const state = task.done
        ? "completed"
        : activeTask?.taskId === task.taskId
          ? "running"
          : (supplied?.[task.taskId] ?? "pending");
      return [task.taskId, state];
    }),
  );
}

function reconciliationWithRenderedTasks(
  reconciliation: PlanRevisionResult,
  renderedTasks: readonly Task[],
): PlanRevisionResult {
  if (renderedTasks.length !== reconciliation.activeTasks.length) {
    throw new Error("Rendered revised plan task count does not match reconciliation output.");
  }
  return {
    ...reconciliation,
    activeTasks: reconciliation.activeTasks.map((item, index) => ({
      ...item,
      task: renderedTasks[index],
    })),
  };
}

function preservedRevisionResults(
  previousTasks: readonly Task[],
  reconciliation: PlanRevisionResult,
  results: readonly PlanRevisionRelevantResult[],
): PreservedPlanRevisionResult[] {
  const previousByTaskId = new Map(previousTasks.map((task) => [task.taskId, task]));
  const activeByPreviousTaskId = new Map(
    reconciliation.activeTasks
      .filter((item) => item.previousTaskId && item.preserveOutputs)
      .map((item) => [item.previousTaskId as string, item]),
  );
  const retiredByPreviousTaskId = new Map(
    reconciliation.retiredTasks
      .filter((item) => item.preserveOutputs)
      .map((item) => {
        const task = previousTasks.find(
          (candidate) => candidate.stableId === item.identity || candidate.taskId === item.task.taskId,
        );
        return task ? [task.taskId, item] : undefined;
      })
      .filter((entry): entry is [string, PlanRevisionResult["retiredTasks"][number]] => Boolean(entry)),
  );

  const preserved: PreservedPlanRevisionResult[] = [];
  for (const result of results) {
    if (!previousByTaskId.has(result.taskId)) {
      throw new Error(`Relevant result refers to unknown current TODO ${result.taskId}.`);
    }
    const active = activeByPreviousTaskId.get(result.taskId);
    if (active) {
      preserved.push({
        previousTaskId: result.taskId,
        identity: active.identity,
        retainedAs: "active",
        result: copyRelevantResult(result),
      });
      continue;
    }
    const retired = retiredByPreviousTaskId.get(result.taskId);
    if (retired) {
      preserved.push({
        previousTaskId: result.taskId,
        identity: retired.identity,
        retainedAs: "history",
        result: copyRelevantResult(result),
      });
    }
  }
  return preserved;
}

function copyRelevantResult(result: PlanRevisionRelevantResult): PlanRevisionRelevantResult {
  return {
    ...result,
    outputReferences: result.outputReferences ? [...result.outputReferences] : undefined,
  };
}

function renumberTaskSection(section: string, taskNumber: number, title: string): string {
  const heading = `## TODO ${taskNumber} — ${title}`;
  if (!/^##\s+TODO\s+\d+\s+[—-]\s+.+$/m.test(section)) {
    throw new Error(`Cannot render revised task ${taskNumber}; its TODO heading is missing.`);
  }
  return section.replace(/^##\s+TODO\s+\d+\s+[—-]\s+.+$/m, heading).trimEnd();
}

function markdownFence(value: string, language: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${fence}${language}\n${value.trim()}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === "`") {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
