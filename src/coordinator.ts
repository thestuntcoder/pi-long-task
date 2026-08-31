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
import { extractResultSummary, hasCompleteTaskResult } from "./result_writer.ts";
import { runGuardedSessionPrompt } from "./session_guard.ts";
import {
  generatePlanRevision,
  PlanRevisionGenerationError,
  type GeneratedPlanRevision,
  type PlanRevisionRequest,
  type PlanRevisionRelevantResult,
} from "./plan_revision_generation.ts";
import { taskSemanticFingerprint, type PlanTaskState } from "./plan_revision.ts";
import {
  PersistentTodoPlanStore,
  planTaskReference,
  resolvePlanTaskReference,
  type PlanTaskReference,
} from "./plan_store.ts";
import type { SerializedSteeringQueue, SteeringMessage } from "./steering.ts";
import { parseWorkerRuntimeConfig } from "./worker_config.ts";
import {
  classifyWorkerSessionRetry,
  createWorkerSessionCompatibilityFingerprint,
  decideWorkerSessionReuse,
  DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT,
  DEFAULT_WORKER_SESSION_REUSE_ENABLED,
  resolveWorkerSessionReuseConfig,
  type WorkerSessionCompatibilityFingerprint,
  type WorkerSessionHealth,
} from "./worker_reuse_policy.ts";
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
import { parseTasks, todoGlobalInstructions, type Task } from "./todo_parser.ts";
import {
  buildWorkerSessionCreationFailureOutcome,
  createIsolatedWorkerSession,
  createWorkerSessionResource,
  DEFAULT_WORKER_TOOLS,
  disposeWorkerSessionResource,
  runWorkerTask,
  runWorkerTaskAssignment,
  workerSessionContextUsagePercent,
  type RunWorkerTaskOptions,
  type SessionOutcome,
  type WorkerSessionDiagnostic,
  type WorkerSessionFactory,
  type WorkerSessionLike,
  type WorkerSessionResource,
  type WorkerUsageTotals,
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
  workerSessionReuse: DEFAULT_WORKER_SESSION_REUSE_ENABLED,
  workerSessionReuseContextThresholdPercent: DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT,
} as const;

export type WorkerRunner = (options: RunWorkerTaskOptions) => Promise<SessionOutcome>;
export type CoordinatorProgressPhase =
  | "planning"
  | "planned"
  | "task_start"
  | "worker_session"
  | "worker_tool"
  | "task_done"
  | "task_blocked"
  | "task_failed"
  | "task_obsolete"
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
  activeStatus?: string;
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
  workerSessionEvent?: WorkerSessionDiagnostic["event"];
  workerSessionReason?: string;
  workerSessionContextUsagePercent?: number;
  workerSessionContextThresholdPercent?: number;
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
  /** Set false to retain the legacy one-session-per-task lifecycle. */
  workerSessionReuse?: boolean;
  /** Rotate before another assignment when context usage reaches this percentage. */
  workerSessionReuseContextThresholdPercent?: number;
  now?: () => Date;
  onProgress?: CoordinatorProgressHandler;
  /** Run-scoped FIFO populated by the extension input handler during active execution. */
  steeringQueue?: SerializedSteeringQueue;
  /** Runs after rebase/validation and immediately before the revision is atomically persisted. */
  onPlanRevisionAccepted?: (revision: GeneratedPlanRevision) => void | Promise<void>;
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
  /** Exact prompt for revision planners; bypasses the initial TODO-creation wrapper. */
  plannerPrompt?: string;
  /** Structured revision context supplied alongside plannerPrompt. */
  planRevision?: Readonly<PlanRevisionRequest>;
}

export interface TaskAttemptSummary {
  taskId: string;
  title: string;
  taskStableId?: string;
  taskFingerprint?: string;
  attempt: number;
  reportedStatus: string;
  done: boolean;
  error?: string;
  commitHash?: string;
  commitError?: string;
  commitSkipped?: string;
  /** The worker finished after an accepted revision replaced or removed its task. */
  obsolete?: boolean;
  /** Retry continuity retained across task renumbering and accepted revisions. */
  resultText?: string;
}

export interface WorkerSessionMetrics {
  starts: number;
  reuses: number;
  rotations: number;
  retained: number;
  rotationReasons: Record<string, number>;
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
  /** Sum of task/attempt token deltas; omitted when statistics are unavailable. */
  workerUsageTotal?: WorkerUsageTotals;
  /** Additive lifecycle counters for adaptive worker-session reuse. */
  workerSessionMetrics?: WorkerSessionMetrics;
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
  workerSessionReuse: boolean;
  workerSessionReuseContextThresholdPercent: number;
  todoTimeoutMs: number;
  todoGracefulShutdownMs: number;
  workerRunner: WorkerRunner;
  useRetainedWorkerLifecycle: boolean;
  todoPlanner: TodoPlanner;
  abortSignal?: AbortSignal;
  workerSessionFactory?: WorkerSessionFactory;
  todoSessionFactory?: WorkerSessionFactory;
  now: () => Date;
  onProgress?: CoordinatorProgressHandler;
  workerCostState: WorkerCostState;
  workerActivityByWorker: Map<string, string>;
  workerTextByWorker: Map<string, string>;
  workerTextPublishedLengthByWorker: Map<string, number>;
  plannerDiagnostics: PlannerDiagnostic[];
  workerSessionMetrics: WorkerSessionMetrics;
  steeringQueue?: SerializedSteeringQueue;
  onPlanRevisionAccepted?: (revision: GeneratedPlanRevision) => void | Promise<void>;
}

type RetainedWorkerReuseScope = "sequential_task" | "partial_continuation";

export interface WorkerAssignmentIdentity {
  /** Unique invocation identity, even when a replacement reuses a task ID and attempt number. */
  assignmentId: string;
  /** Stable task identity or semantic fingerprint from the plan that launched this assignment. */
  taskIdentity: string;
  /** Accepted-steering generation at the assignment boundary. */
  steeringGeneration: number;
  /** Structural plan generation from which the assignment was selected. */
  planAuthorityToken: string;
}

interface RetainedWorkerState {
  resource: WorkerSessionResource;
  compatibility: WorkerSessionCompatibilityFingerprint;
  health: WorkerSessionHealth;
  contextUsagePercent?: number;
  previousTask: Pick<Task, "taskId" | "title">;
  previousAttempt: number;
  previousAssignmentIdentity: WorkerAssignmentIdentity;
  reportDiagnostic: (diagnostic: WorkerSessionDiagnostic) => void;
  reuseScope: RetainedWorkerReuseScope;
}

interface ActiveWorkerSessionAssignment {
  identity: WorkerAssignmentIdentity;
  controller: AbortController;
  tainted: boolean;
  rotationReported: boolean;
  resource?: WorkerSessionResource;
  reportDiagnostic?: (diagnostic: WorkerSessionDiagnostic) => void;
  resolveCompletion: () => void;
  completion: Promise<void>;
}

export interface CoordinatorWorkerSessionOwnerOptions {
  runId: string;
  cwd: string;
  workerSessionReuse: boolean;
  workerSessionReuseContextThresholdPercent: number;
}

/** Run-scoped owner for the single retained worker session and its assignment lock. */
export class CoordinatorWorkerSessionOwner {
  private retained: RetainedWorkerState | undefined;
  private active: ActiveWorkerSessionAssignment | undefined;
  private closed = false;
  private disposePromise: Promise<void> | undefined;
  private assignmentSequence = 0;
  private readonly runtime: CoordinatorWorkerSessionOwnerOptions;

  constructor(runtime: CoordinatorWorkerSessionOwnerOptions) {
    this.runtime = runtime;
  }

  async run(options: RunWorkerTaskOptions, identity?: WorkerAssignmentIdentity): Promise<SessionOutcome> {
    if (this.closed) {
      throw new Error("retained worker session owner is closed");
    }
    const assignmentIdentity = identity ?? this.defaultIdentity(options);
    if (this.active) {
      throw new Error("retained worker session already has an active assignment");
    }

    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveWorkerSessionAssignment = {
      identity: assignmentIdentity,
      controller: new AbortController(),
      tainted: false,
      rotationReported: false,
      resolveCompletion: resolveCompletion as () => void,
      completion,
    };
    this.active = active;
    const assignmentOptions = {
      ...options,
      abortSignal: combineAbortSignals(options.abortSignal, active.controller.signal),
    };
    try {
      return await this.runExclusive(assignmentOptions, assignmentIdentity, active);
    } finally {
      const activeResource = active.resource;
      const retained = this.retained;
      if (active.tainted && activeResource && retained?.resource === activeResource) {
        retained.health = "cancelled";
        await this.disposeRetainedResource(activeResource);
      }
      if (this.active === active) {
        this.active = undefined;
      }
      active.resolveCompletion();
    }
  }

  private async runExclusive(
    options: RunWorkerTaskOptions,
    identity: WorkerAssignmentIdentity,
    active: ActiveWorkerSessionAssignment,
  ): Promise<SessionOutcome> {
    const compatibility = this.compatibilityFor(options);
    const diagnostics: WorkerSessionDiagnostic[] = [];
    const report = (diagnostic: WorkerSessionDiagnostic) => {
      diagnostics.push(diagnostic);
      options.onSessionDiagnostic?.(diagnostic);
    };
    active.reportDiagnostic = report;
    const diagnosticContext = (retained: RetainedWorkerState) => ({
      ...(retained.contextUsagePercent !== undefined ? { contextUsagePercent: retained.contextUsagePercent } : {}),
      contextThresholdPercent: this.runtime.workerSessionReuseContextThresholdPercent,
      previousTaskId: retained.previousTask.taskId,
    });

    let reusedFrom: Pick<Task, "taskId" | "title"> | undefined;
    if (this.retained && !this.assignmentMatchesRetainedScope(options, this.retained)) {
      // A partial-work session is continuity for exactly the next attempt of
      // that task. It must never spill into unrelated work or a later retry.
      report({
        event: "session_rotated",
        reasonCode: "partial_continuation_scope_mismatch",
        ...diagnosticContext(this.retained),
      });
      await this.disposeRetained();
    }
    if (this.retained) {
      const decision = decideWorkerSessionReuse({
        config: {
          enabled: this.runtime.workerSessionReuse,
          contextThresholdPercent: this.runtime.workerSessionReuseContextThresholdPercent,
        },
        candidate: {
          health: this.retained.health,
          compatibility: this.retained.compatibility,
          contextUsagePercent: this.retained.contextUsagePercent,
          assignmentState: "idle",
          disposed: this.retained.resource.disposed,
        },
        requestedCompatibility: compatibility,
      });
      if (decision.reusable) {
        reusedFrom = this.retained.previousTask;
        report({
          event: "session_reused",
          reasonCode: decision.reasonCode,
          ...diagnosticContext(this.retained),
        });
      } else {
        report({
          event: "session_rotated",
          reasonCode: decision.reasonCode,
          ...diagnosticContext(this.retained),
        });
        await this.disposeRetained();
      }
    }

    if (!this.retained) {
      try {
        this.retained = {
          resource: await createWorkerSessionResource(options, options.sessionFactory ?? createIsolatedWorkerSession),
          compatibility,
          health: "healthy",
          previousTask: options.task,
          previousAttempt: options.attempt,
          previousAssignmentIdentity: identity,
          reportDiagnostic: report,
          reuseScope: "sequential_task",
        };
        report({
          event: "session_started",
          reasonCode: diagnostics.some((item) => item.event === "session_rotated")
            ? "rotation_completed"
            : "fresh_session",
          contextThresholdPercent: this.runtime.workerSessionReuseContextThresholdPercent,
        });
      } catch (error) {
        const failed = buildWorkerSessionCreationFailureOutcome(options, error);
        failed.sessionDiagnostics = diagnostics;
        return failed;
      }
    }

    active.resource = this.retained.resource;
    let outcome: SessionOutcome;
    try {
      outcome = await runWorkerTaskAssignment(
        options,
        this.retained.resource,
        reusedFrom ? { previousTask: reusedFrom } : undefined,
      );
    } catch (error) {
      this.retained.health = active.tainted ? "cancelled" : "unrecoverable_error";
      if (!active.rotationReported) {
        active.rotationReported = true;
        report({
          event: "session_rotated",
          reasonCode: "health_unrecoverable_error",
          ...diagnosticContext(this.retained),
        });
      }
      await this.disposeRetained();
      throw error;
    }

    if (this.retained) {
      const cancelled = Boolean(options.abortSignal?.aborted);
      this.retained.health = workerSessionHealthForOutcome(outcome, cancelled);
      this.retained.contextUsagePercent = await workerSessionContextUsagePercent(this.retained.resource.session);
      this.retained.previousTask = options.task;
      this.retained.previousAttempt = options.attempt;
      this.retained.previousAssignmentIdentity = identity;
      this.retained.reportDiagnostic = report;

      if (active.tainted) {
        if (!active.rotationReported) {
          this.reportTaintedRotation(active, "assignment_cancelled");
        }
        await this.disposeRetainedResource(this.retained.resource);
        outcome.sessionDiagnostics = [...(outcome.sessionDiagnostics ?? []), ...diagnostics];
        return outcome;
      }

      const retry = classifyWorkerSessionRetry({
        done: outcome.done,
        reportedStatus: outcome.reportedStatus,
        completeTaskResult: hasCompleteTaskResult(outcome.assistantText),
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        cancelled,
        error: outcome.error,
      });
      this.retained.reuseScope = retry.mayContinueInSession ? "partial_continuation" : "sequential_task";

      const postAssignmentDecision = decideWorkerSessionReuse({
        config: {
          enabled: this.runtime.workerSessionReuse,
          contextThresholdPercent: this.runtime.workerSessionReuseContextThresholdPercent,
        },
        candidate: {
          health: this.retained.health,
          compatibility: this.retained.compatibility,
          contextUsagePercent: this.retained.contextUsagePercent,
          assignmentState: "idle",
          disposed: this.retained.resource.disposed,
        },
        requestedCompatibility: compatibility,
      });
      // Completed tasks may flow into the next sequential TODO. A retry may
      // remain only when it is an explicitly safe partial continuation and all
      // normal health/compatibility/context checks still pass.
      const rotateForRetry = !outcome.done && !retry.mayContinueInSession;
      if (!postAssignmentDecision.reusable || rotateForRetry) {
        if (!active.rotationReported) {
          active.rotationReported = true;
          report({
            event: "session_rotated",
            reasonCode: postAssignmentDecision.reusable ? retry.reasonCode : postAssignmentDecision.reasonCode,
            ...diagnosticContext(this.retained),
          });
        }
        await this.disposeRetained();
      } else {
        report({
          event: "session_retained",
          reasonCode: postAssignmentDecision.reasonCode,
          ...diagnosticContext(this.retained),
        });
      }
    }
    outcome.sessionDiagnostics = [...(outcome.sessionDiagnostics ?? []), ...diagnostics];
    return outcome;
  }

  /**
   * Taint and abort only the matching obsolete assignment. Late cancellation
   * from an older steering generation cannot affect a replacement assignment.
   */
  async invalidateAssignment(identity: WorkerAssignmentIdentity): Promise<boolean> {
    const active = this.active;
    if (active && sameWorkerAssignment(active.identity, identity)) {
      this.taintActiveAssignment(active, "steering_revision_obsolete");
      if (!active.controller.signal.aborted) {
        active.controller.abort(new Error(`worker assignment ${identity.assignmentId} became obsolete`));
      }
      return true;
    }

    if (this.retained && sameWorkerAssignment(this.retained.previousAssignmentIdentity, identity)) {
      const retained = this.retained;
      retained.health = "cancelled";
      retained.reportDiagnostic({
        event: "session_rotated",
        reasonCode: "steering_revision_obsolete",
        ...this.diagnosticContext(retained),
      });
      await this.disposeRetained();
      return true;
    }
    return false;
  }

  /** Abort active work, wait for its ownership path, then dispose retained state once. */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.closed = true;
      this.disposePromise = this.disposeAfterActiveAssignment();
    }
    return this.disposePromise;
  }

  private async disposeAfterActiveAssignment(): Promise<void> {
    const active = this.active;
    if (active) {
      this.taintActiveAssignment(active, "coordinator_shutdown");
      if (!active.controller.signal.aborted) {
        active.controller.abort(new Error("worker session owner disposed"));
      }
      await active.completion;
    }
    await this.disposeRetained();
  }

  private assignmentMatchesRetainedScope(options: RunWorkerTaskOptions, retained: RetainedWorkerState): boolean {
    if (retained.reuseScope === "sequential_task") {
      return true;
    }
    return (
      options.task.taskId === retained.previousTask.taskId &&
      options.task.title === retained.previousTask.title &&
      options.attempt === retained.previousAttempt + 1
    );
  }

  private taintActiveAssignment(active: ActiveWorkerSessionAssignment, reasonCode: string): void {
    active.tainted = true;
    const retained = this.retained;
    if (retained && retained.resource === active.resource) {
      retained.health = "cancelled";
    }
    this.reportTaintedRotation(active, reasonCode);
  }

  private reportTaintedRotation(active: ActiveWorkerSessionAssignment, reasonCode: string): void {
    if (active.rotationReported) return;
    active.rotationReported = true;
    const retained = this.retained;
    active.reportDiagnostic?.({
      event: "session_rotated",
      reasonCode,
      ...(retained ? this.diagnosticContext(retained) : {}),
    });
  }

  private diagnosticContext(retained: RetainedWorkerState): {
    contextUsagePercent?: number;
    contextThresholdPercent: number;
    previousTaskId: string;
  } {
    return {
      ...(retained.contextUsagePercent !== undefined ? { contextUsagePercent: retained.contextUsagePercent } : {}),
      contextThresholdPercent: this.runtime.workerSessionReuseContextThresholdPercent,
      previousTaskId: retained.previousTask.taskId,
    };
  }

  private defaultIdentity(options: RunWorkerTaskOptions): WorkerAssignmentIdentity {
    const sequence = ++this.assignmentSequence;
    return {
      assignmentId: `${options.task.taskId}:${options.attempt}:${sequence}`,
      taskIdentity: `${options.task.taskId}:${options.task.title}`,
      steeringGeneration: 0,
      planAuthorityToken: "direct-owner",
    };
  }

  private compatibilityFor(options: RunWorkerTaskOptions): WorkerSessionCompatibilityFingerprint {
    return createWorkerSessionCompatibilityFingerprint({
      coordinatorRunId: this.runtime.runId,
      repositoryRoot: this.runtime.cwd,
      worktreeRoot: options.cwd,
      modelName: options.modelName,
      model: options.model,
      tools: options.tools ?? DEFAULT_WORKER_TOOLS,
      thinkingLevel: options.thinkingLevel,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime,
      authStorage: options.authStorage,
      modelRegistry: options.modelRegistry,
      settingsManager: options.settingsManager,
      resourceLoader: options.resourceLoader,
      sessionFactory: options.sessionFactory ?? createIsolatedWorkerSession,
    });
  }

  private async disposeRetained(): Promise<void> {
    const retained = this.retained;
    if (!retained) {
      return;
    }
    await this.disposeRetainedResource(retained.resource);
  }

  private async disposeRetainedResource(resource: WorkerSessionResource): Promise<void> {
    if (this.retained?.resource === resource) {
      this.retained = undefined;
    }
    try {
      await disposeWorkerSessionResource(resource);
    } catch {
      // Session disposal is best effort; resource ownership is still closed exactly once.
    }
  }
}

function sameWorkerAssignment(left: WorkerAssignmentIdentity, right: WorkerAssignmentIdentity): boolean {
  return (
    left.assignmentId === right.assignmentId &&
    left.taskIdentity === right.taskIdentity &&
    left.steeringGeneration === right.steeringGeneration &&
    left.planAuthorityToken === right.planAuthorityToken
  );
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (available.length === 0) return undefined;
  if (available.length === 1) return available[0];
  return AbortSignal.any(available);
}

export function workerSessionHealthForOutcome(
  outcome: Pick<SessionOutcome, "timedOut" | "aborted" | "error" | "assistantText">,
  cancelled = false,
): WorkerSessionHealth {
  if (outcome.timedOut) return "timed_out";
  if (cancelled) return "cancelled";
  if (outcome.aborted) return "aborted";
  if (outcome.error) return "unrecoverable_error";
  if (!hasCompleteTaskResult(outcome.assistantText)) return "invalid_state";
  return "healthy";
}

export async function runCoordinator(options: RunCoordinatorOptions): Promise<CoordinatorResult> {
  const runtime = buildRuntimeOptions(options);
  const workerSessionOwner = runtime.useRetainedWorkerLifecycle
    ? new CoordinatorWorkerSessionOwner(runtime)
    : undefined;
  const inputText = coordinatorInputText(options);
  const attempts: TaskAttemptSummary[] = [];
  const outcomes: SessionOutcome[] = [];
  const commits: CoordinatorCommitSummary[] = [];

  await mkdir(runtime.runDir, { recursive: true });
  await writeFile(runtime.taskResultPath, initialTaskResultMarkdown(runtime.runId), "utf8");
  let planningComplete = false;
  let latestTodoMarkdown: string | undefined;
  let latestTasks: Task[] = [];
  let activeTask: Task | undefined;
  let activeTaskReference: PlanTaskReference | undefined;
  let activeAttempt: number | undefined;
  let activeWorkerAssignment:
    | { identity: WorkerAssignmentIdentity; controller: AbortController; obsolete: boolean }
    | undefined;
  let steeringGeneration = 0;
  let workerExecutionSequence = 0;
  let removeSteeringProcessor: (() => void) | undefined;
  const protectedDirtyPathsByTask = new Map<string, Set<string>>();

  try {
    emitProgress(runtime, "Creating TODO plan...", { phase: "planning" });
    let todoMarkdown = await generateOrNormalizeTodoMarkdown(inputText, runtime);
    validateTodoMarkdown(todoMarkdown);
    planningComplete = true;
    latestTodoMarkdown = todoMarkdown;
    const planStore = await PersistentTodoPlanStore.create(runtime.todoPath, todoMarkdown);
    const initialTasks = parseTasks(todoMarkdown);
    latestTasks = initialTasks;
    emitProgress(runtime, `Created TODO plan with ${initialTasks.length} task(s).`, {
      phase: "planned",
      totalTasks: initialTasks.length,
      taskProgress: buildTaskProgressModel({ tasks: initialTasks }),
    });

    let failure: string | undefined;
    removeSteeringProcessor = runtime.steeringQueue?.setProcessor(async (message) => {
      const baseAtRequest = planStore.snapshot();
      const activeTaskAtRequest = activeTaskReference
        ? resolvePlanTaskReference(
            parseTasks(baseAtRequest.markdown),
            activeTaskReference,
            baseAtRequest.authorityToken,
          )
        : undefined;
      try {
        const revision = await generateSteeringPlanRevision({
          message,
          currentTodoMarkdown: baseAtRequest.markdown,
          attempts,
          outcomes,
          commits,
          activeTask: activeTaskAtRequest,
          activeAttempt,
          runtime,
        });
        const currentTasks = parseTasks(planStore.snapshot().markdown);
        const appliedRevision = await planStore.applyRevision(revision, {
          expectedAuthorityToken: baseAtRequest.authorityToken,
          taskStates: coordinatorPlanTaskStates(currentTasks, attempts, activeTaskAtRequest),
          runningTask: activeTaskReference,
          // The callback remains part of acceptance: a rejection occurs before
          // the atomic replacement and therefore leaves the prior plan active.
          beforeCommit: runtime.onPlanRevisionAccepted,
        });
        // The store snapshot is the scheduler's authority at every task
        // boundary, so this accepted revision continues the same run.
        latestTodoMarkdown = appliedRevision.todoMarkdown;
        latestTasks = appliedRevision.reconciliation.activeTasks.map((item) => item.task);
        steeringGeneration += 1;

        // Once replacement/removal is authoritative, make the exact old
        // invocation obsolete before aborting it. Event callbacks consult this
        // identity, so a late old result cannot repaint replacement progress.
        const assignmentAtAcceptance = activeWorkerAssignment;
        const activeStillValid = activeTaskReference
          ? Boolean(resolvePlanTaskReference(latestTasks, activeTaskReference, planStore.snapshot().authorityToken))
          : true;
        if (assignmentAtAcceptance && !activeStillValid) {
          assignmentAtAcceptance.obsolete = true;
          if (!assignmentAtAcceptance.controller.signal.aborted) {
            assignmentAtAcceptance.controller.abort(
              new Error(`steering revision ${message.sequence} replaced the active assignment`),
            );
          }
          await workerSessionOwner?.invalidateAssignment(assignmentAtAcceptance.identity);
        }

        emitProgress(
          runtime,
          `Accepted steering revision ${message.sequence} with ${appliedRevision.reconciliation.activeTasks.length} task(s).`,
          {
            phase: "planned",
            status: "revised",
            totalTasks: appliedRevision.reconciliation.activeTasks.length,
            taskProgress: revisionTaskProgress(appliedRevision),
          },
        );
      } catch (error) {
        const currentSnapshot = planStore.snapshot();
        const messageText =
          error instanceof PlanRevisionGenerationError
            ? `${error.message} The prior plan remains active and this guidance can be retried.`
            : `Plan revision failed. The prior plan remains active: ${errorMessage(error)}`;
        emitProgress(runtime, messageText, {
          phase: "planning",
          status: "revision_failed",
          isError: true,
          totalTasks: parseTasks(currentSnapshot.markdown).length,
          taskProgress: buildTaskProgressModel({ tasks: parseTasks(currentSnapshot.markdown) }),
        });
        throw error;
      }
    });

    while (!runtime.abortSignal?.aborted) {
      // Guidance received before this boundary must settle before selecting
      // more work. Failed revisions leave the prior snapshot usable.
      await runtime.steeringQueue?.waitForIdle();
      const schedulingSnapshot = planStore.snapshot();
      todoMarkdown = schedulingSnapshot.markdown;
      const tasksBeforeAttempt = parseTasks(todoMarkdown);
      latestTasks = tasksBeforeAttempt;
      const nextTask = tasksBeforeAttempt.find((task) => !task.done);
      if (!nextTask) {
        break;
      }

      const priorTaskAttempts = attemptsForTask(tasksBeforeAttempt, attempts, nextTask);
      const attempt = priorTaskAttempts.length + 1;
      const initialActivity =
        nextTask.statusItems.find((item) => !item.done)?.text ?? `Starting TODO ${nextTask.taskId}`;
      const worker = workerKey(nextTask.taskId, attempt);
      // Task IDs and attempt numbers may be reused after an in-flight task is
      // replaced by steering. Accounting needs an invocation identity so the
      // obsolete attempt's finalized spend cannot be overwritten.
      const accountingWorker = `${worker}#${++workerExecutionSequence}`;
      const assignmentIdentity: WorkerAssignmentIdentity = {
        assignmentId: accountingWorker,
        taskIdentity: nextTask.stableId ?? taskSemanticFingerprint(nextTask),
        steeringGeneration,
        planAuthorityToken: schedulingSnapshot.authorityToken,
      };
      const assignmentController = new AbortController();
      const assignmentState = { identity: assignmentIdentity, controller: assignmentController, obsolete: false };
      const taskPlanReference = planTaskReference(nextTask, schedulingSnapshot.authorityToken);
      activeWorkerAssignment = assignmentState;
      activeTask = nextTask;
      activeAttempt = attempt;
      activeTaskReference = taskPlanReference;
      runtime.workerActivityByWorker.set(worker, initialActivity);
      runtime.workerTextByWorker.delete(worker);
      runtime.workerTextPublishedLengthByWorker.delete(worker);
      emitProgress(
        runtime,
        `Running TODO ${nextTask.taskId} — ${nextTask.title}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`,
        {
          phase: "task_start",
          taskId: nextTask.taskId,
          title: nextTask.title,
          attempt,
          activeStatus: initialActivity,
          ...currentTaskProgress(nextTask, "in_progress"),
          taskProgress: buildTaskProgressModel({
            tasks: tasksBeforeAttempt,
            attempts,
            currentTaskId: nextTask.taskId,
          }),
        },
      );
      const executionIdentity = taskExecutionIdentity(nextTask);
      let preExistingDirtyPaths = protectedDirtyPathsByTask.get(executionIdentity);
      if (!preExistingDirtyPaths) {
        preExistingDirtyPaths = options.commit
          ? await gitDirtyPaths(runtime.cwd, runtime.taskResultPath, runtime.todoPath, runtime.runDir)
          : new Set<string>();
        protectedDirtyPathsByTask.set(executionIdentity, preExistingDirtyPaths);
      }
      const workerOptions: RunWorkerTaskOptions = {
        cwd: runtime.cwd,
        todoPath: runtime.todoPath,
        task: nextTask,
        attempt,
        commitRequested: options.commit,
        previousAttempts:
          priorTaskAttempts
            .map((item) => item.resultText)
            .filter((item): item is string => Boolean(item))
            .join("\n\n---\n\n") || undefined,
        globalInstructions: todoGlobalInstructions(todoMarkdown),
        goal: runtime.goal,
        maxBashTimeoutSeconds: runtime.maxBashTimeoutSeconds,
        taskTimeoutSeconds: runtime.taskTimeoutSeconds,
        model: runtime.workerModel,
        modelName: runtime.workerModelName,
        thinkingLevel: runtime.taskThinking,
        abortSignal: combineAbortSignals(runtime.abortSignal, assignmentController.signal),
        sessionFactory: runtime.workerSessionFactory,
        now: runtime.now,
        onEvent: (event) => {
          if (activeWorkerAssignment === assignmentState && !assignmentState.obsolete) {
            emitWorkerEventProgress(runtime, tasksBeforeAttempt, nextTask, attempts, attempt, event, accountingWorker);
          }
        },
        onSessionDiagnostic: (diagnostic) => {
          if (activeWorkerAssignment === assignmentState && !assignmentState.obsolete) {
            emitWorkerSessionProgress(runtime, tasksBeforeAttempt, nextTask, attempts, attempt, diagnostic);
          } else {
            // Lifecycle accounting remains accurate, but obsolete diagnostics
            // must not mutate the replacement task's visible progress.
            recordWorkerSessionMetric(runtime.workerSessionMetrics, diagnostic);
          }
        },
      };
      let outcome: SessionOutcome;
      try {
        outcome = workerSessionOwner
          ? await workerSessionOwner.run(workerOptions, assignmentIdentity)
          : await runtime.workerRunner(workerOptions);
      } catch (error) {
        if (!assignmentState.obsolete) {
          throw error;
        }
        // A cancellation-aware custom runner may reject instead of returning
        // an aborted outcome. Preserve historical evidence, but never let that
        // obsolete rejection terminate or update the replacement assignment.
        outcome = buildWorkerSessionCreationFailureOutcome(workerOptions, error);
        outcome.aborted = true;
      }
      finalizeWorkerCost(runtime.workerCostState, accountingWorker, outcome);

      // A revision may have been accepted while the worker was running. Let all
      // already-received guidance settle, then resolve this exact task identity
      // against the latest plan before applying any terminal state.
      await runtime.steeringQueue?.waitForIdle();
      const initialResolution = await planStore.resolveTask(taskPlanReference);
      const initiallyObsolete = initialResolution.stale || !initialResolution.task;

      // Durable attempt evidence must exist before any completion checkbox is
      // persisted. If this write fails, normal failure handling leaves the task
      // pending and retryable.
      await appendTaskResult(runtime.taskResultPath, nextTask, outcome, initiallyObsolete);
      const settlement = initiallyObsolete
        ? initialResolution
        : outcome.done
          ? await planStore.completeTask(taskPlanReference)
          : await planStore.resolveTask(taskPlanReference);
      const obsolete = settlement.stale || !settlement.task;
      if (obsolete && !initiallyObsolete) {
        await appendObsoleteDisposition(runtime.taskResultPath);
      }
      const settledTask = settlement.task ?? initialResolution.task ?? nextTask;
      todoMarkdown = settlement.snapshot.markdown;
      latestTodoMarkdown = todoMarkdown;
      latestTasks = parseTasks(todoMarkdown);

      const attemptDetails: TaskAttemptSummary = {
        taskId: nextTask.taskId,
        title: nextTask.title,
        taskStableId: nextTask.stableId,
        taskFingerprint: taskSemanticFingerprint(nextTask),
        attempt,
        reportedStatus: outcome.reportedStatus,
        done: outcome.done,
        error: outcome.error,
        obsolete,
        resultText: resultTextForPreviousAttempt(outcome),
      };
      attempts.push(attemptDetails);
      outcomes.push(outcome);

      activeTask = undefined;
      activeTaskReference = undefined;
      activeAttempt = undefined;
      if (activeWorkerAssignment === assignmentState) {
        activeWorkerAssignment = undefined;
      }

      let taskCommitHash: string | undefined;
      let taskCommitError: string | undefined;
      let taskCommitSkipped: string | undefined;
      if (options.commit) {
        const commitResult = obsolete
          ? ({
              skipped: "task was replaced or removed by an accepted plan revision",
            } satisfies CommitAfterSessionResult)
          : shouldCommitOutcome(outcome)
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
          commits.push({ taskId: settledTask.taskId, hash: commitResult.hash, error: commitResult.error });
        }
        taskCommitHash = commitResult.hash;
        taskCommitError = commitResult.error;
        taskCommitSkipped = commitResult.skipped;
        await appendCommitNote(runtime.taskResultPath, commitResult);
      }

      if (obsolete) {
        emitObsoleteTaskOutcomeProgress(runtime, latestTasks, nextTask, attempts, outcome);
        continue;
      }

      emitTaskOutcomeProgress(
        runtime,
        latestTasks,
        settledTask,
        attempts,
        outcome,
        taskCommitHash,
        taskCommitError,
        taskCommitSkipped,
      );

      if (outcome.done) {
        continue;
      }

      if (attempt >= runtime.maxAttemptsPerTask) {
        // Give guidance received at the failure boundary the same chance to
        // replace this work before terminal retry exhaustion is declared.
        await runtime.steeringQueue?.waitForIdle();
        const failureResolution = await planStore.resolveTask(taskPlanReference);
        if (failureResolution.stale || !failureResolution.task) {
          attemptDetails.obsolete = true;
          await appendObsoleteDisposition(runtime.taskResultPath);
          todoMarkdown = failureResolution.snapshot.markdown;
          latestTodoMarkdown = todoMarkdown;
          latestTasks = parseTasks(todoMarkdown);
          emitObsoleteTaskOutcomeProgress(runtime, latestTasks, nextTask, attempts, outcome);
          continue;
        }
        const currentAttemptCount = attemptsForTask(
          parseTasks(failureResolution.snapshot.markdown),
          attempts,
          failureResolution.task,
        ).length;
        if (currentAttemptCount < runtime.maxAttemptsPerTask) {
          continue;
        }
        failure = `TODO ${failureResolution.task.taskId} — ${failureResolution.task.title} did not report done after ${currentAttemptCount} attempt(s).`;
        break;
      }
    }

    const finalTodoMarkdown = await readFile(runtime.todoPath, "utf8");
    const finalTasks = parseTasks(finalTodoMarkdown);
    latestTodoMarkdown = finalTodoMarkdown;
    latestTasks = finalTasks;
    if (runtime.abortSignal?.aborted && !failure && finalTasks.some((task) => !task.done)) {
      failure = "Pi Long Task run aborted.";
    }
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
      workerUsageTotal: aggregateWorkerUsage(outcomes),
      workerSessionMetrics: snapshotWorkerSessionMetrics(runtime.workerSessionMetrics),
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
    const failureNote =
      planningComplete && activeTask
        ? `TODO ${activeTask.taskId} — ${activeTask.title} (attempt ${activeAttempt ?? "unknown"}) failed: ${message}`
        : message;
    try {
      await appendFailureNote(runtime.taskResultPath, failureNote, !planningComplete ? runtime.plannerDiagnostics : []);
    } catch {
      // Best effort only; the original error is returned below.
    }

    if (planningComplete && activeTask && activeAttempt !== undefined) {
      attempts.push({
        taskId: activeTask.taskId,
        title: activeTask.title,
        taskStableId: activeTask.stableId,
        taskFingerprint: taskSemanticFingerprint(activeTask),
        attempt: activeAttempt,
        reportedStatus: "failed",
        done: false,
        error: message,
      });
    }
    if (planningComplete) {
      try {
        latestTodoMarkdown = await readFile(runtime.todoPath, "utf8");
        latestTasks = parseTasks(latestTodoMarkdown);
      } catch {
        // Retain the last valid in-memory task snapshot.
      }
    }
    const completedTasks = latestTasks.filter((task) => task.done).length;
    const remainingTasks = remainingTaskSummaries(latestTasks, attempts);
    const blockedTasks = remainingTasks.filter((task) => task.status === "blocked").length;
    const failedTasks = remainingTasks.filter(
      (task) => task.status !== "blocked" && task.status !== "not_started",
    ).length;
    const taskProgress = buildCompletionTaskProgressModel(latestTasks, attempts, "failed");
    const result: CoordinatorResult = {
      status: "failed",
      summary,
      message: "",
      runId: runtime.runId,
      runDir: runtime.runDir,
      todoPath: runtime.todoPath,
      resultPath: runtime.taskResultPath,
      taskResultPath: runtime.taskResultPath,
      totalTasks: latestTasks.length,
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
      workerUsageTotal: aggregateWorkerUsage(outcomes),
      workerSessionMetrics: snapshotWorkerSessionMetrics(runtime.workerSessionMetrics),
      commit: options.commit,
      goal: runtime.goal,
      error: resultError,
    };
    result.message = formatCoordinatorResultMessage(result);
    emitProgress(runtime, "Pi Long Task failed.", {
      phase: "complete",
      status: "failed",
      totalTasks: latestTasks.length,
      taskProgress,
    });
    return result;
  } finally {
    removeSteeringProcessor?.();
    await workerSessionOwner?.dispose();
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

async function generateSteeringPlanRevision(options: {
  message: Readonly<SteeringMessage>;
  currentTodoMarkdown: string;
  attempts: readonly TaskAttemptSummary[];
  outcomes: readonly SessionOutcome[];
  commits: readonly CoordinatorCommitSummary[];
  activeTask: Task | undefined;
  activeAttempt: number | undefined;
  runtime: RuntimeOptions;
}): Promise<GeneratedPlanRevision> {
  const currentTasks = parseTasks(options.currentTodoMarkdown);
  const taskStates = coordinatorPlanTaskStates(currentTasks, options.attempts, options.activeTask);

  return generatePlanRevision({
    currentTodoMarkdown: options.currentTodoMarkdown,
    guidance: options.message.text,
    revisionId: options.message.id,
    taskStates,
    relevantResults: relevantPlanRevisionResults(currentTasks, options.attempts, options.outcomes, options.commits),
    activeTask: options.activeTask
      ? {
          taskId: options.activeTask.taskId,
          title: options.activeTask.title,
          attempt: options.activeAttempt,
          activity: options.runtime.workerActivityByWorker.get(
            workerKey(options.activeTask.taskId, options.activeAttempt ?? 1),
          ),
        }
      : undefined,
    planner: ({ prompt, request }) =>
      options.runtime.todoPlanner({
        inputText: prompt,
        plannerPrompt: prompt,
        planRevision: request,
        cwd: options.runtime.cwd,
        runDir: options.runtime.runDir,
        thinkingLevel: options.runtime.todoThinking,
        model: options.runtime.workerModel,
        abortSignal: options.runtime.abortSignal,
        timeoutMs: options.runtime.todoTimeoutMs,
        gracefulShutdownMs: options.runtime.todoGracefulShutdownMs,
        sessionFactory: options.runtime.todoSessionFactory,
        onDiagnostic: (diagnostic) => recordPlannerDiagnostic(options.runtime, diagnostic),
        goal: options.runtime.goal,
      }),
  });
}

function coordinatorPlanTaskStates(
  tasks: readonly Task[],
  attempts: readonly TaskAttemptSummary[],
  activeTask: Task | undefined,
): Record<string, PlanTaskState> {
  const lastAttemptByTask = new Map<string, TaskAttemptSummary>();
  for (const attempt of taskProgressAttempts(tasks, attempts)) {
    lastAttemptByTask.set(attempt.taskId, attempt);
  }

  return Object.fromEntries(
    tasks.map((task) => {
      const attempt = lastAttemptByTask.get(task.taskId);
      const state: PlanTaskState = task.done
        ? "completed"
        : activeTask?.stableId && task.stableId === activeTask.stableId
          ? "running"
          : activeTask?.taskId === task.taskId && task.title === activeTask.title
            ? "running"
            : attempt?.reportedStatus === "blocked"
              ? "blocked"
              : attempt
                ? "failed"
                : "pending";
      return [task.taskId, state];
    }),
  );
}

function revisionTaskProgress(revision: GeneratedPlanRevision): TaskProgressModel {
  const tasks = revision.reconciliation.activeTasks.map((item) => item.task);
  const running = revision.reconciliation.activeTasks.find((item) => item.state === "running");
  const stateAttempts = revision.reconciliation.activeTasks.flatMap((item) => {
    if (item.state !== "failed" && item.state !== "blocked") {
      return [];
    }
    return [
      {
        taskId: item.task.taskId,
        reportedStatus: item.state,
        done: false,
      },
    ];
  });
  return buildTaskProgressModel({
    tasks,
    attempts: stateAttempts,
    currentTaskId: running?.task.taskId,
  });
}

function relevantPlanRevisionResults(
  currentTasks: readonly Task[],
  attempts: readonly TaskAttemptSummary[],
  outcomes: readonly SessionOutcome[],
  commits: readonly CoordinatorCommitSummary[],
): PlanRevisionRelevantResult[] {
  const commitByTask = new Map(
    commits.filter((commit) => commit.hash).map((commit) => [commit.taskId, commit.hash as string]),
  );

  return currentTasks.flatMap((task) => {
    if (!task.done) {
      return [];
    }
    const completedAttempt = attemptsForTask(currentTasks, attempts, task)
      .filter((attempt) => attempt.done)
      .at(-1);
    if (!completedAttempt) {
      return [];
    }
    const outcome = [...outcomes]
      .reverse()
      .find(
        (item) =>
          item.attempt === completedAttempt.attempt &&
          item.task.title === completedAttempt.title &&
          (!completedAttempt.taskFingerprint ||
            taskSemanticFingerprint(item.task as Task) === completedAttempt.taskFingerprint),
      );
    const commitHash = completedAttempt.commitHash ?? commitByTask.get(completedAttempt.taskId);
    const outputReferences = [
      outcome?.sessionFile ? `session:${outcome.sessionFile}` : undefined,
      outcome?.sessionId ? `session-id:${outcome.sessionId}` : undefined,
      commitHash ? `commit:${commitHash}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return [
      {
        taskId: task.taskId,
        status: completedAttempt.reportedStatus,
        summary:
          (outcome ? extractResultSummary(outcome.assistantText).trim() : "") || `Completed TODO ${task.taskId}.`,
        outputReferences,
      },
    ];
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
      prompt: options.plannerPrompt ?? buildTodoCreationPrompt(options.inputText, options.goal),
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
  const workerSessionReuseConfig = resolveWorkerSessionReuseConfig({
    enabled: options.workerSessionReuse ?? parsedWorkerConfig.workerSessionReuseEnabled,
    contextThresholdPercent:
      options.workerSessionReuseContextThresholdPercent ?? parsedWorkerConfig.workerSessionReuseContextThresholdPercent,
  });

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
    workerSessionReuse: workerSessionReuseConfig.enabled,
    workerSessionReuseContextThresholdPercent: workerSessionReuseConfig.contextThresholdPercent,
    workerRunner: options.workerRunner ?? runWorkerTask,
    useRetainedWorkerLifecycle: options.workerRunner === undefined,
    todoPlanner: options.todoPlanner ?? runTodoPlanner,
    abortSignal: options.abortSignal,
    workerSessionFactory: options.workerSessionFactory,
    todoSessionFactory: options.todoSessionFactory,
    now: options.now ?? (() => new Date()),
    onProgress: options.onProgress,
    workerCostState: createWorkerCostState(),
    workerActivityByWorker: new Map(),
    workerTextByWorker: new Map(),
    workerTextPublishedLengthByWorker: new Map(),
    plannerDiagnostics: [],
    workerSessionMetrics: createWorkerSessionMetrics(),
    steeringQueue: options.steeringQueue,
    onPlanRevisionAccepted: options.onPlanRevisionAccepted,
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

function aggregateWorkerUsage(outcomes: readonly SessionOutcome[]): WorkerUsageTotals | undefined {
  const usage = outcomes.flatMap((outcome) => (outcome.workerUsage ? [outcome.workerUsage] : []));
  if (usage.length === 0) {
    return undefined;
  }
  return usage.reduce<WorkerUsageTotals>(
    (total, item) => ({
      input: total.input + item.input,
      output: total.output + item.output,
      cacheRead: total.cacheRead + item.cacheRead,
      cacheWrite: total.cacheWrite + item.cacheWrite,
      total: total.total + item.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
}

function createWorkerSessionMetrics(): WorkerSessionMetrics {
  return { starts: 0, reuses: 0, rotations: 0, retained: 0, rotationReasons: {} };
}

function snapshotWorkerSessionMetrics(metrics: WorkerSessionMetrics): WorkerSessionMetrics {
  return { ...metrics, rotationReasons: { ...metrics.rotationReasons } };
}

function recordWorkerSessionMetric(metrics: WorkerSessionMetrics, diagnostic: WorkerSessionDiagnostic): void {
  if (diagnostic.event === "session_started") metrics.starts += 1;
  if (diagnostic.event === "session_reused") metrics.reuses += 1;
  if (diagnostic.event === "session_retained") metrics.retained += 1;
  if (diagnostic.event === "session_rotated") {
    metrics.rotations += 1;
    metrics.rotationReasons[diagnostic.reasonCode] = (metrics.rotationReasons[diagnostic.reasonCode] ?? 0) + 1;
  }
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
  worker: string,
  outcome: Pick<SessionOutcome, "workerCostTotal">,
): void {
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

function emitWorkerSessionProgress(
  runtime: RuntimeOptions,
  tasks: readonly Task[],
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  attempts: readonly TaskAttemptSummary[],
  attempt: number,
  diagnostic: WorkerSessionDiagnostic,
): void {
  recordWorkerSessionMetric(runtime.workerSessionMetrics, diagnostic);
  const contextText =
    diagnostic.contextUsagePercent === undefined
      ? ""
      : ` at ${diagnostic.contextUsagePercent.toFixed(1)}% context usage`;
  const action =
    diagnostic.event === "session_started"
      ? "started"
      : diagnostic.event === "session_reused"
        ? "reused"
        : diagnostic.event === "session_rotated"
          ? "rotated"
          : "retained";
  emitProgress(runtime, `Worker session ${action}${contextText} (${diagnostic.reasonCode}).`, {
    phase: "worker_session",
    taskId: task.taskId,
    title: task.title,
    attempt,
    status: "in_progress",
    activeStatus: `Worker session ${action}`,
    workerSessionEvent: diagnostic.event,
    workerSessionReason: diagnostic.reasonCode,
    workerSessionContextUsagePercent: diagnostic.contextUsagePercent,
    workerSessionContextThresholdPercent: diagnostic.contextThresholdPercent,
    ...currentTaskProgress(task, "in_progress"),
    taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
  });
}

function emitWorkerEventProgress(
  runtime: RuntimeOptions,
  tasks: readonly Task[],
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  attempts: readonly TaskAttemptSummary[],
  attempt: number,
  event: {
    type: string;
    toolName?: string;
    activity?: string;
    textDelta?: string;
    isError?: boolean;
    usageCostTotal?: number;
    usageCostKey?: string;
  },
  accountingWorker = workerKey(task.taskId, attempt),
): void {
  const worker = workerKey(task.taskId, attempt);
  let activeStatus = runtime.workerActivityByWorker.get(worker);

  if (event.type === "message_update" && event.textDelta) {
    const workerText = `${runtime.workerTextByWorker.get(worker) ?? ""}${event.textDelta}`;
    runtime.workerTextByWorker.set(worker, workerText);
    const streamedStatus = activeStatusFromWorkerText(workerText);
    const publishedLength = runtime.workerTextPublishedLengthByWorker.get(worker) ?? 0;
    const publishBoundary = /[\n.!?:]\s*$/.test(event.textDelta) || streamedStatus.length - publishedLength >= 48;
    if (streamedStatus && publishBoundary) {
      activeStatus = streamedStatus;
      runtime.workerActivityByWorker.set(worker, activeStatus);
      runtime.workerTextPublishedLengthByWorker.set(worker, streamedStatus.length);
      emitProgress(runtime, activeStatus, {
        phase: "worker_tool",
        taskId: task.taskId,
        title: task.title,
        attempt,
        status: "in_progress",
        workerEventType: event.type,
        activeStatus,
        ...currentTaskProgress(task, "in_progress"),
        taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
      });
    }
    return;
  }

  if (event.type === "message_end") {
    runtime.workerTextByWorker.delete(worker);
    runtime.workerTextPublishedLengthByWorker.delete(worker);
  }

  if (event.activity) {
    activeStatus = event.activity;
    runtime.workerActivityByWorker.set(worker, activeStatus);
  }

  const costChanged =
    event.usageCostTotal !== undefined && recordLiveWorkerCost(runtime.workerCostState, accountingWorker, event);

  if (event.type === "message_end" && event.activity) {
    emitProgress(runtime, event.activity, {
      phase: "worker_tool",
      taskId: task.taskId,
      title: task.title,
      attempt,
      status: "in_progress",
      workerEventType: event.type,
      activeStatus,
      ...currentTaskProgress(task, "in_progress"),
      taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
    });
    return;
  }

  if (!event.toolName || (event.type !== "tool_execution_start" && event.type !== "tool_execution_end")) {
    if (costChanged) {
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
          activeStatus,
          ...currentTaskProgress(task, "in_progress"),
          taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
        },
      );
    }
    return;
  }

  const action = event.type === "tool_execution_start" ? "started" : event.isError ? "failed" : "finished";
  if (event.type === "tool_execution_end") {
    const previousActivity = stripToolOutcomePrefix(
      runtime.workerActivityByWorker.get(worker) ?? `Running ${event.toolName}`,
    );
    activeStatus = event.isError ? `Failed: ${previousActivity}` : `Finished: ${previousActivity}`;
    runtime.workerActivityByWorker.set(worker, activeStatus);
  } else {
    // Every tool start begins a new activity. Keeping the previous tool's completed
    // status here causes each later tool end to prepend another "Finished:" label.
    activeStatus = event.activity ?? `Running ${event.toolName}`;
    runtime.workerActivityByWorker.set(worker, activeStatus);
  }

  const update: Omit<CoordinatorProgressUpdate, "message" | "runId" | "todoPath" | "resultPath" | "workerCostTotal"> = {
    phase: "worker_tool",
    taskId: task.taskId,
    title: task.title,
    attempt,
    status: action,
    toolName: event.toolName,
    workerEventType: event.type,
    activeStatus,
    isError: event.isError,
    ...currentTaskProgress(task, "in_progress"),
    taskProgress: buildTaskProgressModel({ tasks, attempts, currentTaskId: task.taskId }),
  };
  if (event.isError) {
    update.status = "failed";
  }
  emitProgress(runtime, activeStatus, update);
}

function stripToolOutcomePrefix(activity: string): string {
  return activity.trim().replace(/^(?:(?:Finished|Failed):\s*)+/i, "");
}

function activeStatusFromWorkerText(text: string): string {
  const taskResultIndex = text.indexOf("TASK_RESULT:");
  return (taskResultIndex >= 0 ? text.slice(0, taskResultIndex) : text).replace(/\s+/g, " ").trim();
}

function emitObsoleteTaskOutcomeProgress(
  runtime: RuntimeOptions,
  tasks: readonly Task[],
  task: Pick<Task, "taskId" | "title" | "statusItems">,
  attempts: readonly TaskAttemptSummary[],
  outcome: SessionOutcome,
): void {
  emitProgress(
    runtime,
    `TODO ${task.taskId} result was retained as obsolete because an accepted revision replaced or removed the in-flight task.`,
    {
      phase: "task_obsolete",
      taskId: task.taskId,
      title: task.title,
      attempt: outcome.attempt,
      status: "obsolete",
      taskProgress: buildTaskProgressModel({ tasks, attempts }),
    },
  );
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

function taskProgressAttempts(tasks: readonly Task[], attempts: readonly TaskAttemptSummary[]): TaskAttemptSummary[] {
  return attempts.flatMap((attempt) => {
    if (attempt.obsolete) {
      return [];
    }
    const fingerprintMatches = attempt.taskFingerprint
      ? tasks.filter((task) => taskSemanticFingerprint(task) === attempt.taskFingerprint)
      : [];
    const stableMatches =
      !attempt.taskFingerprint && attempt.taskStableId
        ? tasks.filter((task) => task.stableId === attempt.taskStableId)
        : [];
    const matched =
      fingerprintMatches.length === 1
        ? fingerprintMatches[0]
        : stableMatches.length === 1
          ? stableMatches[0]
          : !attempt.taskFingerprint
            ? tasks.find((task) => task.taskId === attempt.taskId && task.title === attempt.title)
            : undefined;
    return matched ? [{ ...attempt, taskId: matched.taskId, title: matched.title }] : [];
  });
}

function attemptsForTask(
  tasks: readonly Task[],
  attempts: readonly TaskAttemptSummary[],
  task: Pick<Task, "taskId">,
): TaskAttemptSummary[] {
  return taskProgressAttempts(tasks, attempts).filter((attempt) => attempt.taskId === task.taskId);
}

function taskExecutionIdentity(task: Task): string {
  return task.stableId
    ? `stable:${task.stableId}:${taskSemanticFingerprint(task)}`
    : `semantic:${taskSemanticFingerprint(task)}`;
}

function buildCompletionTaskProgressModel(
  tasks: readonly Task[],
  attempts: readonly TaskAttemptSummary[],
  status: CoordinatorStatus,
): TaskProgressModel {
  const currentAttempts = taskProgressAttempts(tasks, attempts);
  if (status === "done") {
    return buildTaskProgressModel({ tasks, attempts: currentAttempts });
  }

  const lastIncompleteAttempt = [...currentAttempts].reverse().find((attempt) => !attempt.done);
  if (!lastIncompleteAttempt) {
    return buildTaskProgressModel({ tasks, attempts: currentAttempts });
  }

  return buildTaskProgressModel({
    tasks,
    attempts: currentAttempts,
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

async function appendTaskResult(
  pathname: string,
  task: Task,
  outcome: SessionOutcome,
  obsolete = false,
): Promise<void> {
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
  if (obsolete) {
    lines.push(obsoleteDispositionText());
  }

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
  if (outcome.workerCostSource || outcome.workerCostTotal > 0) {
    lines.push(`Worker cost: ${outcome.workerCostTotal} (${outcome.workerCostSource ?? "unavailable"})`);
  }
  if (outcome.workerUsage) {
    lines.push(
      `Worker token usage: input=${outcome.workerUsage.input}, output=${outcome.workerUsage.output}, cacheRead=${outcome.workerUsage.cacheRead}, cacheWrite=${outcome.workerUsage.cacheWrite}, total=${outcome.workerUsage.total}`,
    );
  }
  if (outcome.sessionDiagnostics?.length) {
    lines.push(
      "",
      "Worker session diagnostics:",
      ...outcome.sessionDiagnostics.map((item) => {
        const context =
          item.contextUsagePercent === undefined ? "" : ` context=${item.contextUsagePercent.toFixed(1)}%`;
        return `- event=${item.event} reason=${item.reasonCode}${context}`;
      }),
    );
  }
  if (outcome.compactionEvents.length > 0) {
    lines.push("", "Compaction events:", ...outcome.compactionEvents.map((item) => `- ${item}`));
  }

  lines.push("", "```text", summary, "```", "");
  await appendFile(pathname, `${lines.join("\n")}\n`, "utf8");
}

async function appendObsoleteDisposition(pathname: string): Promise<void> {
  await appendFile(pathname, `\n${obsoleteDispositionText()}\n`, "utf8");
}

function obsoleteDispositionText(): string {
  return "Plan disposition: obsolete — an accepted revision replaced or removed this in-flight task; its result did not update plan status.";
}

function remainingTaskSummaries(tasks: Task[], attempts: TaskAttemptSummary[]): CoordinatorRemainingTask[] {
  const lastAttemptByTask = new Map<string, TaskAttemptSummary>();
  for (const attempt of taskProgressAttempts(tasks, attempts)) {
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
