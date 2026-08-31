import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorkerSessionRetry,
  createWorkerSessionCompatibilityFingerprint,
  decideWorkerSessionReuse,
  DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT,
  normalizeWorkerSessionReuseThreshold,
  resolveWorkerSessionReuseConfig,
  type WorkerSessionCompatibilityFingerprint,
  type WorkerSessionReuseCandidate,
  type WorkerSessionReuseReasonCode,
} from "../src/worker_reuse_policy.ts";

const ALL_REUSE_REASON_CODES = {
  reuse_eligible: true,
  reuse_disabled: true,
  session_disposed: true,
  session_active: true,
  health_unknown: true,
  health_timed_out: true,
  health_aborted: true,
  health_cancelled: true,
  health_unrecoverable_error: true,
  health_invalid_state: true,
  coordinator_run_mismatch: true,
  repository_mismatch: true,
  worktree_mismatch: true,
  provider_mismatch: true,
  model_mismatch: true,
  worker_options_mismatch: true,
  session_configuration_mismatch: true,
  context_usage_unavailable: true,
  context_usage_invalid: true,
  context_threshold_reached: true,
} satisfies Record<WorkerSessionReuseReasonCode, true>;

function fingerprint(overrides: Record<string, unknown> = {}): WorkerSessionCompatibilityFingerprint {
  return createWorkerSessionCompatibilityFingerprint({
    coordinatorRunId: "run-1",
    repositoryRoot: "/repo",
    worktreeRoot: "/repo/worktree",
    modelName: "anthropic/claude-sonnet-4",
    tools: ["read", "edit"],
    thinkingLevel: "high",
    ...overrides,
  });
}

function candidate(
  compatibility: WorkerSessionCompatibilityFingerprint,
  overrides: Partial<WorkerSessionReuseCandidate> = {},
): WorkerSessionReuseCandidate {
  return {
    health: "healthy",
    compatibility,
    contextUsagePercent: 40,
    assignmentState: "idle",
    disposed: false,
    ...overrides,
  };
}

function decision(options: {
  current?: WorkerSessionCompatibilityFingerprint;
  requested?: WorkerSessionCompatibilityFingerprint;
  usage?: number;
  enabled?: boolean;
  threshold?: number;
  candidateOverrides?: Partial<WorkerSessionReuseCandidate>;
}) {
  const current = options.current ?? fingerprint();
  return decideWorkerSessionReuse({
    config: resolveWorkerSessionReuseConfig({
      enabled: options.enabled,
      contextThresholdPercent: options.threshold,
    }),
    candidate: candidate(current, {
      ...(options.usage !== undefined ? { contextUsagePercent: options.usage } : {}),
      ...options.candidateOverrides,
    }),
    requestedCompatibility: options.requested ?? current,
  });
}

test("reuse reason-code catalog stays exhaustive as policy states evolve", () => {
  assert.equal(Object.keys(ALL_REUSE_REASON_CODES).length, 20);
});

test("reuse policy defaults and threshold boundaries are conservative", () => {
  assert.equal(DEFAULT_WORKER_SESSION_REUSE_CONTEXT_THRESHOLD_PERCENT, 62.5);
  assert.deepEqual(resolveWorkerSessionReuseConfig({}), {
    enabled: true,
    contextThresholdPercent: 62.5,
  });
  assert.equal(decision({ usage: 0 }).reasonCode, "reuse_eligible");
  assert.equal(decision({ usage: 62.49 }).reasonCode, "reuse_eligible");
  assert.equal(decision({ usage: 62.5 }).reasonCode, "context_threshold_reached");
  assert.equal(decision({ usage: 80 }).state, "rotation_required");
});

test("invalid thresholds normalize to the documented safe default", () => {
  for (const value of [-1, 0, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeWorkerSessionReuseThreshold(value), 62.5);
  }
  assert.equal(normalizeWorkerSessionReuseThreshold(1), 1);
  assert.equal(normalizeWorkerSessionReuseThreshold(100), 100);
});

test("reuse can be disabled to retain isolated sessions", () => {
  assert.deepEqual(decision({ enabled: false }), {
    state: "isolated",
    reasonCode: "reuse_disabled",
    reusable: false,
    healthy: true,
    contextUsagePercent: 40,
    contextThresholdPercent: 62.5,
  });
});

test("missing, invalid, or excessive context usage requires rotation", () => {
  assert.equal(
    decision({ candidateOverrides: { contextUsagePercent: undefined } }).reasonCode,
    "context_usage_unavailable",
  );
  assert.equal(decision({ usage: -1 }).reasonCode, "context_usage_invalid");
  assert.equal(decision({ usage: 101 }).reasonCode, "context_usage_invalid");
});

test("unhealthy and non-idle sessions cannot be reused", () => {
  assert.equal(decision({ candidateOverrides: { health: "timed_out" } }).reasonCode, "health_timed_out");
  assert.equal(decision({ candidateOverrides: { health: "aborted" } }).reasonCode, "health_aborted");
  assert.equal(decision({ candidateOverrides: { health: "cancelled" } }).reasonCode, "health_cancelled");
  assert.equal(
    decision({ candidateOverrides: { health: "unrecoverable_error" } }).reasonCode,
    "health_unrecoverable_error",
  );
  assert.equal(decision({ candidateOverrides: { health: "invalid_state" } }).reasonCode, "health_invalid_state");
  assert.equal(decision({ candidateOverrides: { health: "unknown" } }).reasonCode, "health_unknown");
  assert.equal(decision({ candidateOverrides: { assignmentState: "active" } }).reasonCode, "session_active");
  assert.equal(decision({ candidateOverrides: { disposed: true } }).reasonCode, "session_disposed");
});

test("unrelated runs, worktrees, models, providers, and worker options are incompatible", () => {
  const current = fingerprint();
  const cases: Array<[WorkerSessionCompatibilityFingerprint, string]> = [
    [fingerprint({ coordinatorRunId: "run-2" }), "coordinator_run_mismatch"],
    [fingerprint({ repositoryRoot: "/other-repo" }), "repository_mismatch"],
    [fingerprint({ worktreeRoot: "/repo/other-worktree" }), "worktree_mismatch"],
    [fingerprint({ modelName: "openai/claude-sonnet-4" }), "provider_mismatch"],
    [fingerprint({ modelName: "anthropic/claude-opus-4" }), "model_mismatch"],
    [fingerprint({ thinkingLevel: "xhigh" }), "worker_options_mismatch"],
  ];

  for (const [requested, expectedReason] of cases) {
    assert.equal(decision({ current, requested }).reasonCode, expectedReason);
  }
});

test("retry classification permits only explicit healthy partial-work continuation", () => {
  const base = {
    done: false,
    reportedStatus: "partial",
    completeTaskResult: true,
    timedOut: false,
    aborted: false,
  };

  assert.deepEqual(classifyWorkerSessionRetry(base), {
    mode: "safe_partial_continuation",
    reasonCode: "explicit_partial_work",
    mayContinueInSession: true,
  });
  assert.equal(classifyWorkerSessionRetry({ ...base, done: true }).mode, "no_retry");
  assert.equal(classifyWorkerSessionRetry({ ...base, timedOut: true }).reasonCode, "retry_after_timeout");
  assert.equal(classifyWorkerSessionRetry({ ...base, aborted: true }).reasonCode, "retry_after_abort");
  assert.equal(classifyWorkerSessionRetry({ ...base, cancelled: true }).reasonCode, "retry_after_cancellation");
  assert.equal(classifyWorkerSessionRetry({ ...base, error: "transport failed" }).reasonCode, "retry_after_error");
  assert.equal(
    classifyWorkerSessionRetry({ ...base, completeTaskResult: false }).reasonCode,
    "retry_after_invalid_result",
  );
  for (const reportedStatus of ["failed", "blocked", "unknown", "incomplete"]) {
    assert.equal(classifyWorkerSessionRetry({ ...base, reportedStatus }).reasonCode, "retry_after_non_partial_status");
  }
});

test("other session-affecting configuration uses stable conservative fingerprints", () => {
  const runtime = { name: "runtime" };
  const current = fingerprint({ modelRuntime: runtime, sessionConfiguration: { feature: true } });
  const equivalent = fingerprint({ modelRuntime: runtime, sessionConfiguration: { feature: true } });
  const differentRuntime = fingerprint({ modelRuntime: { name: "runtime" }, sessionConfiguration: { feature: true } });
  const differentConfiguration = fingerprint({ modelRuntime: runtime, sessionConfiguration: { feature: false } });

  assert.equal(decision({ current, requested: equivalent }).reasonCode, "reuse_eligible");
  assert.equal(decision({ current, requested: differentRuntime }).reasonCode, "session_configuration_mismatch");
  assert.equal(decision({ current, requested: differentConfiguration }).reasonCode, "session_configuration_mismatch");
});
