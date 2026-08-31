import path from "node:path";

/** Reuse starts conservatively rotating before two thirds of the context is occupied. */
export const DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT = 62.5;
export const DEFAULT_WORKER_SESSION_REUSE_ENABLED = true;

export interface WorkerSessionReuseConfig {
  enabled: boolean;
  contextThresholdPercent: number;
}

export interface WorkerSessionCompatibilityInput {
  coordinatorRunId: string;
  repositoryRoot: string;
  worktreeRoot?: string;
  provider?: string;
  modelName?: string;
  model?: unknown;
  tools?: readonly string[];
  thinkingLevel?: string;
  /** Any additional worker option whose value changes session behavior. */
  workerOptions?: Readonly<Record<string, unknown>>;
  agentDir?: string;
  modelRuntime?: unknown;
  authStorage?: unknown;
  modelRegistry?: unknown;
  settingsManager?: unknown;
  resourceLoader?: unknown;
  sessionFactory?: unknown;
  /** Additional options that can alter the constructed AgentSession. */
  sessionConfiguration?: Readonly<Record<string, unknown>>;
}

/**
 * A run-scoped description of every input that can make two worker sessions
 * incompatible. Individual fields are retained so policy diagnostics can name
 * the mismatch instead of reporting only an opaque hash.
 */
export interface WorkerSessionCompatibilityFingerprint {
  coordinatorRunId: string;
  repositoryRoot: string;
  worktreeRoot: string;
  provider: string;
  model: string;
  workerOptions: string;
  sessionConfiguration: string;
}

export type WorkerSessionHealth =
  | "healthy"
  | "unknown"
  | "timed_out"
  | "aborted"
  | "cancelled"
  | "unrecoverable_error"
  | "invalid_state";

export type WorkerSessionReuseState = "reusable" | "rotation_required" | "isolated";

export type WorkerSessionRetryMode = "no_retry" | "safe_partial_continuation" | "independent_retry";

export type WorkerSessionRetryReasonCode =
  | "task_completed"
  | "explicit_partial_work"
  | "retry_after_timeout"
  | "retry_after_abort"
  | "retry_after_cancellation"
  | "retry_after_error"
  | "retry_after_invalid_result"
  | "retry_after_non_partial_status";

export interface WorkerSessionRetryInput {
  done: boolean;
  reportedStatus: string;
  completeTaskResult: boolean;
  timedOut: boolean;
  aborted: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface WorkerSessionRetryDecision {
  mode: WorkerSessionRetryMode;
  reasonCode: WorkerSessionRetryReasonCode;
  mayContinueInSession: boolean;
}

export type WorkerSessionReuseReasonCode =
  | "reuse_eligible"
  | "reuse_disabled"
  | "session_disposed"
  | "session_active"
  | "health_unknown"
  | "health_timed_out"
  | "health_aborted"
  | "health_cancelled"
  | "health_unrecoverable_error"
  | "health_invalid_state"
  | "coordinator_run_mismatch"
  | "repository_mismatch"
  | "worktree_mismatch"
  | "provider_mismatch"
  | "model_mismatch"
  | "worker_options_mismatch"
  | "session_configuration_mismatch"
  | "context_usage_unavailable"
  | "context_usage_invalid"
  | "context_threshold_reached";

export interface WorkerSessionReuseCandidate {
  health: WorkerSessionHealth;
  compatibility: WorkerSessionCompatibilityFingerprint;
  /** A normalized percentage in the inclusive range 0..100. */
  contextUsagePercent?: number;
  assignmentState: "idle" | "active";
  disposed: boolean;
}

export interface WorkerSessionReusePolicyInput {
  config: WorkerSessionReuseConfig;
  candidate: WorkerSessionReuseCandidate;
  requestedCompatibility: WorkerSessionCompatibilityFingerprint;
}

export interface WorkerSessionReuseDecision {
  state: WorkerSessionReuseState;
  reasonCode: WorkerSessionReuseReasonCode;
  reusable: boolean;
  healthy: boolean;
  contextUsagePercent?: number;
  contextThresholdPercent: number;
}

const objectIds = new WeakMap<object, number>();
const symbolIds = new Map<symbol, number>();
let nextObjectId = 1;

export function normalizeWorkerSessionReuseThreshold(value: unknown): number {
  return isValidThresholdPercentage(value) ? value : DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT;
}

export function resolveWorkerSessionReuseConfig(options: {
  enabled?: boolean;
  contextThresholdPercent?: number;
}): WorkerSessionReuseConfig {
  return {
    enabled: options.enabled ?? DEFAULT_WORKER_SESSION_REUSE_ENABLED,
    contextThresholdPercent: normalizeWorkerSessionReuseThreshold(options.contextThresholdPercent),
  };
}

export function createWorkerSessionCompatibilityFingerprint(
  input: WorkerSessionCompatibilityInput,
): WorkerSessionCompatibilityFingerprint {
  const parsedModel = splitProviderModel(input.modelName);
  const provider = normalizeOptional(input.provider) ?? parsedModel.provider ?? "<default>";
  const model = parsedModel.model
    ? `name:${parsedModel.model}`
    : input.model !== undefined
      ? `value:${fingerprintValue(input.model)}`
      : "<default>";
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const worktreeRoot = path.resolve(input.worktreeRoot ?? repositoryRoot);

  return {
    coordinatorRunId: input.coordinatorRunId,
    repositoryRoot,
    worktreeRoot,
    provider,
    model,
    workerOptions: canonicalRecord({
      tools: input.tools ? [...input.tools] : undefined,
      thinkingLevel: input.thinkingLevel,
      workerOptions: input.workerOptions,
    }),
    sessionConfiguration: canonicalRecord({
      agentDir: input.agentDir ? path.resolve(input.agentDir) : undefined,
      modelRuntime: fingerprintOpaqueOption(input.modelRuntime),
      authStorage: fingerprintOpaqueOption(input.authStorage),
      modelRegistry: fingerprintOpaqueOption(input.modelRegistry),
      settingsManager: fingerprintOpaqueOption(input.settingsManager),
      resourceLoader: fingerprintOpaqueOption(input.resourceLoader),
      sessionFactory: fingerprintOpaqueOption(input.sessionFactory),
      sessionConfiguration: input.sessionConfiguration,
    }),
  };
}

/**
 * Classify retry ownership independently from session health. Only an explicit,
 * complete `partial` result is eligible to continue in the same session; every
 * failure mode remains an independent attempt and therefore starts fresh.
 */
export function classifyWorkerSessionRetry(input: WorkerSessionRetryInput): WorkerSessionRetryDecision {
  if (input.timedOut) {
    return { mode: "independent_retry", reasonCode: "retry_after_timeout", mayContinueInSession: false };
  }
  if (input.cancelled) {
    return { mode: "independent_retry", reasonCode: "retry_after_cancellation", mayContinueInSession: false };
  }
  if (input.aborted) {
    return { mode: "independent_retry", reasonCode: "retry_after_abort", mayContinueInSession: false };
  }
  if (input.error) {
    return { mode: "independent_retry", reasonCode: "retry_after_error", mayContinueInSession: false };
  }
  if (input.done) {
    return { mode: "no_retry", reasonCode: "task_completed", mayContinueInSession: false };
  }
  if (!input.completeTaskResult) {
    return { mode: "independent_retry", reasonCode: "retry_after_invalid_result", mayContinueInSession: false };
  }
  if (input.reportedStatus.trim().toLowerCase() === "partial") {
    return { mode: "safe_partial_continuation", reasonCode: "explicit_partial_work", mayContinueInSession: true };
  }
  return { mode: "independent_retry", reasonCode: "retry_after_non_partial_status", mayContinueInSession: false };
}

/** Decide whether an idle completed session can accept the next assignment. */
export function decideWorkerSessionReuse(input: WorkerSessionReusePolicyInput): WorkerSessionReuseDecision {
  const threshold = normalizeWorkerSessionReuseThreshold(input.config.contextThresholdPercent);
  const base = {
    contextThresholdPercent: threshold,
    ...(input.candidate.contextUsagePercent !== undefined
      ? { contextUsagePercent: input.candidate.contextUsagePercent }
      : {}),
  };

  if (!input.config.enabled) {
    return {
      ...base,
      state: "isolated",
      reasonCode: "reuse_disabled",
      reusable: false,
      healthy: input.candidate.health === "healthy" && !input.candidate.disposed,
    };
  }
  if (input.candidate.disposed) {
    return { ...base, state: "rotation_required", reasonCode: "session_disposed", reusable: false, healthy: false };
  }
  if (input.candidate.assignmentState === "active") {
    return { ...base, state: "rotation_required", reasonCode: "session_active", reusable: false, healthy: false };
  }
  if (input.candidate.health !== "healthy") {
    return {
      ...base,
      state: "rotation_required",
      reasonCode: healthReason(input.candidate.health),
      reusable: false,
      healthy: false,
    };
  }

  const incompatibility = compatibilityReason(input.candidate.compatibility, input.requestedCompatibility);
  if (incompatibility) {
    return { ...base, state: "rotation_required", reasonCode: incompatibility, reusable: false, healthy: true };
  }

  const usage = input.candidate.contextUsagePercent;
  if (usage === undefined) {
    return {
      ...base,
      state: "rotation_required",
      reasonCode: "context_usage_unavailable",
      reusable: false,
      healthy: true,
    };
  }
  if (!isValidContextUsagePercentage(usage)) {
    return {
      ...base,
      state: "rotation_required",
      reasonCode: "context_usage_invalid",
      reusable: false,
      healthy: true,
    };
  }
  if (usage >= threshold) {
    return {
      ...base,
      state: "rotation_required",
      reasonCode: "context_threshold_reached",
      reusable: false,
      healthy: true,
    };
  }

  return { ...base, state: "reusable", reasonCode: "reuse_eligible", reusable: true, healthy: true };
}

function compatibilityReason(
  current: WorkerSessionCompatibilityFingerprint,
  requested: WorkerSessionCompatibilityFingerprint,
): WorkerSessionReuseReasonCode | undefined {
  if (current.coordinatorRunId !== requested.coordinatorRunId) return "coordinator_run_mismatch";
  if (current.repositoryRoot !== requested.repositoryRoot) return "repository_mismatch";
  if (current.worktreeRoot !== requested.worktreeRoot) return "worktree_mismatch";
  if (current.provider !== requested.provider) return "provider_mismatch";
  if (current.model !== requested.model) return "model_mismatch";
  if (current.workerOptions !== requested.workerOptions) return "worker_options_mismatch";
  if (current.sessionConfiguration !== requested.sessionConfiguration) return "session_configuration_mismatch";
  return undefined;
}

function healthReason(health: Exclude<WorkerSessionHealth, "healthy">): WorkerSessionReuseReasonCode {
  return health === "unknown" ? "health_unknown" : `health_${health}`;
}

function splitProviderModel(modelName: string | undefined): { provider?: string; model?: string } {
  const normalized = normalizeOptional(modelName);
  if (!normalized) return {};
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return { model: normalized };
  return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) };
}

function canonicalRecord(value: Readonly<Record<string, unknown>>, seen = new Set<object>()): string {
  return Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${fingerprintValue(value[key], seen)}`)
    .join("|");
}

function fingerprintValue(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return opaqueValue(value);
  }
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (seen.has(value)) return opaqueValue(value);
    seen.add(value);
    const result = `[${value.map((item) => fingerprintValue(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return opaqueValue(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      seen.add(value);
      const result = `{${canonicalRecord(value as Record<string, unknown>, seen)}}`;
      seen.delete(value);
      return result;
    }
    return opaqueValue(value);
  }
  return String(value);
}

function fingerprintOpaqueOption(value: unknown): string | undefined {
  return value === undefined ? undefined : opaqueValue(value);
}

function opaqueValue(value: unknown): string {
  if ((typeof value !== "object" || value === null) && typeof value !== "function" && typeof value !== "symbol") {
    return `${typeof value}:${String(value)}`;
  }
  if (typeof value === "symbol") {
    let symbolId = symbolIds.get(value);
    if (!symbolId) {
      symbolId = nextObjectId++;
      symbolIds.set(value, symbolId);
    }
    return `identity:${symbolId}`;
  }
  const object = value as object;
  let objectId = objectIds.get(object);
  if (!objectId) {
    objectId = nextObjectId++;
    objectIds.set(object, objectId);
  }
  return `identity:${objectId}`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isValidThresholdPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function isValidContextUsagePercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
