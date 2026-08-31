import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { reconcilePlanRevision, taskSemanticFingerprint, type PlanTaskState } from "./plan_revision.ts";
import { renderReconciledTodoMarkdown, type GeneratedPlanRevision } from "./plan_revision_generation.ts";
import { markTaskDone, parseTasks, type Task } from "./todo_parser.ts";
import { validateTodoMarkdown } from "./todo_generator.ts";

export interface PersistedPlanSnapshot {
  markdown: string;
  /** Changes only when plan structure/content changes, not when checkboxes change. */
  authorityToken: string;
}

export interface PlanTaskReference {
  taskId: string;
  stableId?: string;
  semanticFingerprint: string;
  authorityToken: string;
}

export interface ApplyPersistedPlanRevisionOptions {
  expectedAuthorityToken: string;
  taskStates?: Readonly<Record<string, PlanTaskState>>;
  runningTask?: PlanTaskReference;
  /** Runs while writes are serialized and before the authoritative file is replaced. */
  beforeCommit?: (revision: GeneratedPlanRevision) => void | Promise<void>;
}

export interface ResolvePersistedTaskResult {
  task?: Task;
  stale: boolean;
  snapshot: PersistedPlanSnapshot;
}

export interface CompletePersistedTaskResult extends ResolvePersistedTaskResult {
  applied: boolean;
}

export class StalePlanRevisionError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = "StalePlanRevisionError";
  }
}

/**
 * Serialized, atomic persistence for the authoritative TODO document.
 *
 * Every mutation is derived from the latest in-memory snapshot and reaches disk
 * through a same-directory temporary file + rename. Structural authority tokens
 * let status-only writes rebase safely while rejecting planner output generated
 * from an older accepted plan.
 */
export class PersistentTodoPlanStore {
  readonly todoPath: string;
  private markdown: string;
  private authorityToken: string;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(todoPath: string, markdown: string) {
    validateTodoMarkdown(markdown);
    this.todoPath = todoPath;
    this.markdown = markdown;
    this.authorityToken = planAuthorityToken(markdown);
  }

  static async create(todoPath: string, markdown: string): Promise<PersistentTodoPlanStore> {
    const store = new PersistentTodoPlanStore(todoPath, markdown);
    await atomicWrite(todoPath, markdown);
    return store;
  }

  /** Restores the exact rendered plan state from the authoritative TODO file. */
  static async load(todoPath: string): Promise<PersistentTodoPlanStore> {
    return new PersistentTodoPlanStore(todoPath, await readFile(todoPath, "utf8"));
  }

  /** Restores from content already read by a caller. */
  static fromPersistedMarkdown(todoPath: string, markdown: string): PersistentTodoPlanStore {
    return new PersistentTodoPlanStore(todoPath, markdown);
  }

  snapshot(): PersistedPlanSnapshot {
    return { markdown: this.markdown, authorityToken: this.authorityToken };
  }

  async applyRevision(
    revision: GeneratedPlanRevision,
    options: ApplyPersistedPlanRevisionOptions,
  ): Promise<GeneratedPlanRevision> {
    return this.withWriteLock(async () => {
      if (options.expectedAuthorityToken !== this.authorityToken) {
        throw new StalePlanRevisionError(
          `Plan revision ${revision.revisionId} was generated from a stale plan and cannot replace the latest revision.`,
        );
      }

      const currentTasks = parseTasks(this.markdown);
      const renderedTargetTasks = parseTasks(revision.todoMarkdown);
      if (renderedTargetTasks.length !== revision.reconciliation.activeTasks.length) {
        throw new Error("Persisted revision task count does not match its reconciliation state.");
      }
      const currentByTaskId = new Map(currentTasks.map((task) => [task.taskId, task]));
      const targetTasks = renderedTargetTasks.map((task, index) => {
        const item = revision.reconciliation.activeTasks[index];
        const previous = item?.previousTaskId ? currentByTaskId.get(item.previousTaskId) : undefined;
        const shouldMatchPrevious = previous && item.revisionKind !== "follow_up" && item.revisedTaskId !== undefined;
        return shouldMatchPrevious ? taskWithStableId(task, previous.stableId) : task;
      });
      const runningTaskId = options.runningTask
        ? resolvePlanTaskReference(currentTasks, options.runningTask, this.authorityToken)?.taskId
        : undefined;
      const taskStates = Object.fromEntries(
        currentTasks.map((task) => [
          task.taskId,
          task.done ? "completed" : (options.taskStates?.[task.taskId] ?? "pending"),
        ]),
      ) as Record<string, PlanTaskState>;
      const reconciliation = reconcilePlanRevision(currentTasks, targetTasks, {
        previousStates: taskStates,
        runningTaskId,
        revisionId: revision.revisionId,
      });
      const todoMarkdown = renderReconciledTodoMarkdown(revision.todoMarkdown, reconciliation.activeTasks);
      validateTodoMarkdown(todoMarkdown);
      const renderedTasks = parseTasks(todoMarkdown);
      const appliedRevision: GeneratedPlanRevision = {
        ...revision,
        todoMarkdown,
        reconciliation: {
          ...reconciliation,
          activeTasks: reconciliation.activeTasks.map((item, index) => ({
            ...item,
            task: renderedTasks[index],
          })),
        },
      };

      await options.beforeCommit?.(appliedRevision);
      await atomicWrite(this.todoPath, todoMarkdown);
      this.markdown = todoMarkdown;
      this.authorityToken = planAuthorityToken(todoMarkdown);
      return appliedRevision;
    });
  }

  /**
   * Marks the equivalent task in the latest plan complete. If an accepted
   * revision replaced that work, the stale worker update becomes a no-op.
   */
  async completeTask(reference: PlanTaskReference): Promise<CompletePersistedTaskResult> {
    return this.withWriteLock(async () => {
      const tasks = parseTasks(this.markdown);
      const task = resolvePlanTaskReference(tasks, reference, this.authorityToken);
      if (!task) {
        return { applied: false, stale: true, snapshot: this.snapshot() };
      }
      if (task.done) {
        return { applied: false, stale: false, task, snapshot: this.snapshot() };
      }

      const nextMarkdown = markTaskDone(this.markdown, task.taskId);
      validateTodoMarkdown(nextMarkdown);
      await atomicWrite(this.todoPath, nextMarkdown);
      this.markdown = nextMarkdown;
      // Completion updates only checkboxes, so the structural token normally
      // remains unchanged. Recompute it to keep this invariant verified.
      this.authorityToken = planAuthorityToken(nextMarkdown);
      const snapshot = this.snapshot();
      const completedTask = resolvePlanTaskReference(parseTasks(snapshot.markdown), reference, snapshot.authorityToken);
      return { applied: true, stale: false, task: completedTask, snapshot };
    });
  }

  /** Resolves an in-flight worker identity against the latest accepted plan. */
  async resolveTask(reference: PlanTaskReference): Promise<ResolvePersistedTaskResult> {
    return this.withWriteLock(async () => {
      const snapshot = this.snapshot();
      const task = resolvePlanTaskReference(parseTasks(snapshot.markdown), reference, snapshot.authorityToken);
      return { task, stale: !task, snapshot };
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: (() => void) | undefined;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function taskWithStableId(task: Task, stableId: string | undefined): Task {
  const markerPattern = /^[\t ]*<!--[\t ]*pi-long-task-id:.*-->[\t ]*(?:\r?\n)?/im;
  const withoutMarker = task.section.replace(markerPattern, "");
  if (!stableId) {
    return { ...task, stableId: undefined, section: withoutMarker };
  }
  const headingEnd = withoutMarker.search(/\r?\n/);
  const marker = `<!-- pi-long-task-id: ${stableId} -->`;
  const section =
    headingEnd < 0
      ? `${withoutMarker}\n\n${marker}\n`
      : `${withoutMarker.slice(0, headingEnd + 1)}\n${marker}\n${withoutMarker.slice(headingEnd + 1).replace(/^\n/, "")}`;
  return { ...task, stableId, section };
}

export function planTaskReference(task: Task, authorityToken: string): PlanTaskReference {
  return {
    taskId: task.taskId,
    stableId: task.stableId,
    semanticFingerprint: taskSemanticFingerprint(task),
    authorityToken,
  };
}

/** Stable across checkbox-only task completion writes. */
export function planAuthorityToken(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^(\s*-\s+\[)[ xX](\])/gm, "$1 $2")
    .trimEnd();
  // A deterministic content token avoids persisting a second source of truth.
  return `plan:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function resolvePlanTaskReference(
  tasks: readonly Task[],
  reference: PlanTaskReference,
  currentAuthorityToken: string,
): Task | undefined {
  if (reference.stableId) {
    const stableMatches = tasks.filter(
      (task) => task.stableId === reference.stableId && taskSemanticFingerprint(task) === reference.semanticFingerprint,
    );
    if (stableMatches.length === 1) {
      return stableMatches[0];
    }
    // Once a worker has a persisted identity, a newer revision must not let it
    // fall through to semantically similar work under a different identity.
    // Fingerprint fallback is reserved for legacy workers launched before IDs
    // were first added to their plan.
    if (reference.authorityToken !== currentAuthorityToken) {
      return undefined;
    }
  }

  const semanticMatches = tasks.filter((task) => taskSemanticFingerprint(task) === reference.semanticFingerprint);
  if (semanticMatches.length === 1) {
    return semanticMatches[0];
  }

  if (reference.authorityToken === currentAuthorityToken) {
    return tasks.find((task) => task.taskId === reference.taskId);
  }
  return undefined;
}

async function atomicWrite(pathname: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(pathname),
    `.${path.basename(pathname)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, content, "utf8");
  try {
    await rename(temporaryPath, pathname);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
