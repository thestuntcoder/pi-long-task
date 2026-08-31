import { createHash } from "node:crypto";

import { markTaskDone, markTaskPending, type Task } from "./todo_parser.ts";

/**
 * State owned by the coordinator for a task. Revised planner markdown is never
 * trusted to supply this state.
 */
export const PLAN_TASK_STATE_VALUES = ["pending", "running", "completed", "failed", "blocked"] as const;
export type PlanTaskState = (typeof PLAN_TASK_STATE_VALUES)[number];

export type PlanTaskMatchKind = "stable_id" | "exact_content" | "unique_title";
export type PlanTaskRevisionKind = "unchanged" | "modified" | "inserted" | "follow_up";
export type RetiredPlanTaskReason = "removed" | "superseded" | "invalidated";

export interface PlanTaskMatch {
  previousTaskId: string;
  revisedTaskId: string;
  kind: PlanTaskMatchKind;
  /** True only when relative order changed, not merely when insertion shifted an index. */
  reordered: boolean;
  contentChanged: boolean;
}

/** An item in the accepted, schedulable plan, including preserved completed items. */
export interface ReconciledPlanTask {
  identity: string;
  task: Task;
  state: PlanTaskState;
  revisionKind: PlanTaskRevisionKind;
  previousTaskId?: string;
  revisedTaskId?: string;
  matchKind?: PlanTaskMatchKind;
  reordered: boolean;
  /** Existing result/commit references may be attached to this identity. */
  preserveOutputs: boolean;
  /** Set when changed requirements must be executed without erasing prior completed work. */
  followUpForIdentity?: string;
}

/** Historical work excluded from scheduling but retained for results/audit rendering. */
export interface RetiredPlanTask {
  identity: string;
  task: Task;
  state: PlanTaskState;
  reason: RetiredPlanTaskReason;
  preserveOutputs: boolean;
}

export interface ReconcilePlanRevisionOptions {
  /** Coordinator-owned states keyed by IDs in the previous plan. Parsed `done` still wins. */
  previousStates?: Readonly<Record<string, PlanTaskState>>;
  /** The task whose worker is currently in flight, if any. */
  runningTaskId?: string;
  /**
   * Explicitly invalidated IDs from the previous plan. Their history is retained and
   * replacement/follow-up work is made pending, even if proposed content is unchanged.
   */
  invalidatedTaskIds?: readonly string[];
  /** Used to make generated follow-up identities stable within a persisted revision. */
  revisionId?: string;
}

export interface PlanRevisionResult {
  activeTasks: ReconciledPlanTask[];
  retiredTasks: RetiredPlanTask[];
  matches: PlanTaskMatch[];
  /** In-flight results for these previous task IDs must not mutate the accepted plan. */
  staleRunningTaskIds: string[];
}

export class PlanRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRevisionError";
  }
}

interface InternalMatch {
  previousIndex: number;
  revisedIndex: number;
  kind: PlanTaskMatchKind;
}

/**
 * Deterministically reconciles a validated revised plan with coordinator-owned state.
 *
 * Match precedence is: explicit stable ID, exact semantic content, then a title that
 * is unique among the remaining tasks on both sides. Ambiguous tasks are intentionally
 * treated as remove+insert rather than risking progress transfer to the wrong work.
 */
export function reconcilePlanRevision(
  previousTasks: readonly Task[],
  revisedTasks: readonly Task[],
  options: ReconcilePlanRevisionOptions = {},
): PlanRevisionResult {
  assertUniqueStableIds(previousTasks, "previous");
  assertUniqueStableIds(revisedTasks, "revised");
  assertUniqueTaskIds(previousTasks, "previous");
  assertUniqueTaskIds(revisedTasks, "revised");

  const previousIndexByTaskId = new Map(previousTasks.map((task, index) => [task.taskId, index]));
  if (options.runningTaskId && !previousIndexByTaskId.has(options.runningTaskId)) {
    throw new PlanRevisionError(`Running task TODO ${options.runningTaskId} is not present in the previous plan.`);
  }

  const invalidated = new Set(options.invalidatedTaskIds ?? []);
  for (const taskId of invalidated) {
    if (!previousIndexByTaskId.has(taskId)) {
      throw new PlanRevisionError(`Invalidated task TODO ${taskId} is not present in the previous plan.`);
    }
  }

  const internalMatches = matchTasks(previousTasks, revisedTasks);
  const matchByRevisedIndex = new Map(internalMatches.map((match) => [match.revisedIndex, match]));
  const matchByPreviousIndex = new Map(internalMatches.map((match) => [match.previousIndex, match]));
  const reorderedMatches = reorderedMatchKeys(internalMatches);
  const revisionId = normalizedRevisionId(options.revisionId);
  const previousIdentities = taskIdentities(previousTasks, "legacy");
  const revisedIdentities = taskIdentities(revisedTasks, "inserted");
  const previousStates = previousTasks.map((task) => previousTaskState(task, options));

  const activeTasks: ReconciledPlanTask[] = [];
  const retiredTasks: RetiredPlanTask[] = [];
  const staleRunningTaskIds: string[] = [];

  for (let revisedIndex = 0; revisedIndex < revisedTasks.length; revisedIndex += 1) {
    const revisedTask = revisedTasks[revisedIndex];
    const match = matchByRevisedIndex.get(revisedIndex);
    if (!match) {
      activeTasks.push({
        identity: revisedIdentities[revisedIndex],
        task: taskForState(revisedTask, "pending", revisedIdentities[revisedIndex]),
        state: "pending",
        revisionKind: "inserted",
        revisedTaskId: revisedTask.taskId,
        reordered: false,
        preserveOutputs: false,
      });
      continue;
    }

    const previousTask = previousTasks[match.previousIndex];
    const previousState = previousStates[match.previousIndex];
    const previousIdentity = previousIdentities[match.previousIndex];
    const contentChanged = taskSemanticFingerprint(previousTask) !== taskSemanticFingerprint(revisedTask);
    const explicitlyInvalidated = invalidated.has(previousTask.taskId);
    const changed = contentChanged || explicitlyInvalidated;
    const reordered = reorderedMatches.has(matchKey(match));

    if (!changed) {
      activeTasks.push({
        identity: previousIdentity,
        task: taskForState(revisedTask, previousState, previousIdentity),
        state: previousState,
        revisionKind: "unchanged",
        previousTaskId: previousTask.taskId,
        revisedTaskId: revisedTask.taskId,
        matchKind: match.kind,
        reordered,
        preserveOutputs: previousState === "completed",
      });
      continue;
    }

    const mustRetainPrior = previousState === "completed" || previousState === "running";
    if (mustRetainPrior) {
      retiredTasks.push({
        identity: previousIdentity,
        task: taskForState(previousTask, previousState, previousIdentity),
        state: previousState,
        reason: explicitlyInvalidated ? "invalidated" : "superseded",
        preserveOutputs: previousState === "completed",
      });
    }
    if (previousState === "running") {
      staleRunningTaskIds.push(previousTask.taskId);
    }

    const requiresFollowUp = previousState === "completed";
    const nextIdentity = requiresFollowUp
      ? followUpIdentity(previousIdentity, revisedTask, revisionId)
      : previousIdentity;
    activeTasks.push({
      identity: nextIdentity,
      task: taskForState(revisedTask, "pending", nextIdentity),
      state: "pending",
      revisionKind: requiresFollowUp ? "follow_up" : "modified",
      previousTaskId: previousTask.taskId,
      revisedTaskId: revisedTask.taskId,
      matchKind: match.kind,
      reordered,
      preserveOutputs: false,
      followUpForIdentity: requiresFollowUp ? previousIdentity : undefined,
    });
  }

  for (let previousIndex = 0; previousIndex < previousTasks.length; previousIndex += 1) {
    if (matchByPreviousIndex.has(previousIndex)) {
      continue;
    }
    const previousTask = previousTasks[previousIndex];
    const previousState = previousStates[previousIndex];
    const previousIdentity = previousIdentities[previousIndex];
    const explicitlyInvalidated = invalidated.has(previousTask.taskId);

    retiredTasks.push({
      identity: previousIdentity,
      task: taskForState(previousTask, previousState, previousIdentity),
      state: previousState,
      reason: explicitlyInvalidated ? "invalidated" : "removed",
      preserveOutputs: previousState === "completed",
    });

    if (previousState === "running") {
      staleRunningTaskIds.push(previousTask.taskId);
    }
    if (explicitlyInvalidated) {
      const nextIdentity = followUpIdentity(previousIdentity, previousTask, revisionId);
      activeTasks.push({
        identity: nextIdentity,
        task: taskForState(previousTask, "pending", nextIdentity),
        state: "pending",
        revisionKind: previousState === "completed" ? "follow_up" : "modified",
        previousTaskId: previousTask.taskId,
        reordered: false,
        preserveOutputs: false,
        followUpForIdentity: previousState === "completed" ? previousIdentity : undefined,
      });
    }
  }

  return {
    activeTasks,
    retiredTasks,
    matches: internalMatches.map((match) => {
      const previousTask = previousTasks[match.previousIndex];
      const revisedTask = revisedTasks[match.revisedIndex];
      return {
        previousTaskId: previousTask.taskId,
        revisedTaskId: revisedTask.taskId,
        kind: match.kind,
        reordered: reorderedMatches.has(matchKey(match)),
        contentChanged: taskSemanticFingerprint(previousTask) !== taskSemanticFingerprint(revisedTask),
      };
    }),
    staleRunningTaskIds: [...new Set(staleRunningTaskIds)],
  };
}

/** Semantic content excludes numbering, stable-ID markers, checkbox state, and formatting-only whitespace. */
export function taskSemanticFingerprint(task: Task): string {
  const lines = task.section.replace(/\r\n?/g, "\n").split("\n");
  const body = lines
    .slice(1)
    .filter((line) => !/^\s*<!--\s*pi-long-task-id:.*-->\s*$/i.test(line))
    .map((line) =>
      line
        .replace(/^(\s*-\s+\[)[ xX](\])/, "$1 $2")
        .replace(/[\t ]+/g, " ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${normalizedTitle(task.title)}\n${body}`;
}

function matchTasks(previousTasks: readonly Task[], revisedTasks: readonly Task[]): InternalMatch[] {
  const matches: InternalMatch[] = [];
  const usedPrevious = new Set<number>();
  const usedRevised = new Set<number>();

  const previousStable = indexByStableId(previousTasks);
  revisedTasks.forEach((task, revisedIndex) => {
    if (!task.stableId) {
      return;
    }
    const previousIndex = previousStable.get(task.stableId);
    if (previousIndex !== undefined) {
      addMatch(matches, usedPrevious, usedRevised, previousIndex, revisedIndex, "stable_id");
    }
  });

  const previousByFingerprint = unmatchedGroups(previousTasks, usedPrevious, (task) =>
    task.stableId ? undefined : taskSemanticFingerprint(task),
  );
  const revisedByFingerprint = unmatchedGroups(revisedTasks, usedRevised, (task) =>
    task.stableId ? undefined : taskSemanticFingerprint(task),
  );
  for (const [fingerprint, previousIndexes] of previousByFingerprint) {
    const revisedIndexes = revisedByFingerprint.get(fingerprint) ?? [];
    const count = Math.min(previousIndexes.length, revisedIndexes.length);
    for (let index = 0; index < count; index += 1) {
      addMatch(matches, usedPrevious, usedRevised, previousIndexes[index], revisedIndexes[index], "exact_content");
    }
  }

  const previousByTitle = unmatchedGroups(previousTasks, usedPrevious, (task) =>
    task.stableId ? undefined : normalizedTitle(task.title),
  );
  const revisedByTitle = unmatchedGroups(revisedTasks, usedRevised, (task) =>
    task.stableId ? undefined : normalizedTitle(task.title),
  );
  for (const [title, previousIndexes] of previousByTitle) {
    const revisedIndexes = revisedByTitle.get(title) ?? [];
    if (previousIndexes.length === 1 && revisedIndexes.length === 1) {
      addMatch(matches, usedPrevious, usedRevised, previousIndexes[0], revisedIndexes[0], "unique_title");
    }
  }

  return matches.sort((left, right) => left.revisedIndex - right.revisedIndex);
}

function addMatch(
  matches: InternalMatch[],
  usedPrevious: Set<number>,
  usedRevised: Set<number>,
  previousIndex: number,
  revisedIndex: number,
  kind: PlanTaskMatchKind,
): void {
  if (usedPrevious.has(previousIndex) || usedRevised.has(revisedIndex)) {
    return;
  }
  usedPrevious.add(previousIndex);
  usedRevised.add(revisedIndex);
  matches.push({ previousIndex, revisedIndex, kind });
}

function unmatchedGroups(
  tasks: readonly Task[],
  used: ReadonlySet<number>,
  keyForTask: (task: Task) => string | undefined,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  tasks.forEach((task, index) => {
    if (used.has(index)) {
      return;
    }
    const key = keyForTask(task);
    if (!key) {
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return groups;
}

function reorderedMatchKeys(matches: readonly InternalMatch[]): Set<string> {
  const reordered = new Set<string>();
  for (let leftIndex = 0; leftIndex < matches.length; leftIndex += 1) {
    const left = matches[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex += 1) {
      const right = matches[rightIndex];
      const previousOrder = Math.sign(left.previousIndex - right.previousIndex);
      const revisedOrder = Math.sign(left.revisedIndex - right.revisedIndex);
      if (previousOrder !== revisedOrder) {
        reordered.add(matchKey(left));
        reordered.add(matchKey(right));
      }
    }
  }
  return reordered;
}

function matchKey(match: InternalMatch): string {
  return `${match.previousIndex}:${match.revisedIndex}`;
}

function previousTaskState(task: Task, options: ReconcilePlanRevisionOptions): PlanTaskState {
  if (task.done) {
    return "completed";
  }
  if (options.runningTaskId === task.taskId) {
    return "running";
  }
  return options.previousStates?.[task.taskId] ?? "pending";
}

function taskForState(task: Task, state: PlanTaskState, identity: string): Task {
  const done = state === "completed";
  return {
    ...task,
    stableId: identity,
    section:
      state === "completed"
        ? markTaskDone(sectionWithStableId(task.section, identity), task.taskId)
        : markTaskPending(sectionWithStableId(task.section, identity), task.taskId),
    done,
    progressDone: done,
    statusCheckboxes: task.statusCheckboxes.map(() => done),
    statusItems: task.statusItems.map((item) => ({ ...item, done })),
  };
}

function sectionWithStableId(section: string, identity: string): string {
  const marker = `<!-- pi-long-task-id: ${identity} -->`;
  if (/^[\t ]*<!--[\t ]*pi-long-task-id:.*-->[\t ]*$/im.test(section)) {
    return section.replace(/^[\t ]*<!--[\t ]*pi-long-task-id:.*-->[\t ]*$/im, marker);
  }
  const headingEnd = section.search(/\r?\n/);
  if (headingEnd < 0) {
    return `${section}\n\n${marker}\n`;
  }
  const newline = section.startsWith("\r\n", headingEnd) ? "\r\n" : "\n";
  const insertAt = headingEnd + newline.length;
  return `${section.slice(0, insertAt)}${marker}${newline}${section.slice(insertAt)}`;
}

function taskIdentities(tasks: readonly Task[], prefix: string): string[] {
  const occurrences = new Map<string, number>();
  return tasks.map((task) => {
    if (task.stableId) {
      return task.stableId;
    }
    const digest = digestText(taskSemanticFingerprint(task));
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    return `${prefix}:${digest}:${occurrence}`;
  });
}

function followUpIdentity(previousIdentity: string, task: Task, revisionId: string): string {
  return `follow-up:${digestText(`${previousIdentity}\n${taskSemanticFingerprint(task)}\n${revisionId}`)}`;
}

function normalizedRevisionId(value: string | undefined): string {
  return value?.trim() || "revision";
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function indexByStableId(tasks: readonly Task[]): Map<string, number> {
  const indexes = new Map<string, number>();
  tasks.forEach((task, index) => {
    if (task.stableId) {
      indexes.set(task.stableId, index);
    }
  });
  return indexes;
}

function assertUniqueStableIds(tasks: readonly Task[], label: string): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.stableId) {
      continue;
    }
    if (seen.has(task.stableId)) {
      throw new PlanRevisionError(`Duplicate pi-long-task-id ${JSON.stringify(task.stableId)} in ${label} plan.`);
    }
    seen.add(task.stableId);
  }
}

function assertUniqueTaskIds(tasks: readonly Task[], label: string): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.taskId)) {
      throw new PlanRevisionError(`Duplicate TODO ${task.taskId} in ${label} plan.`);
    }
    seen.add(task.taskId);
  }
}
