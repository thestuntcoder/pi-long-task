import { classifyNetworkFailure, type NetworkFailureClassification } from "./network_failure.ts";
import type { NetworkRecoveryConfig } from "./network_recovery_config.ts";

/** One-based network retry number. This counter is deliberately independent of TODO/session attempts. */
export interface NetworkRetryContext {
  readonly retryCount: number;
  readonly outageStartedAtMs: number;
  readonly elapsedMs: number;
  readonly networkWaitMs: number;
  readonly signal?: AbortSignal;
}

export interface NetworkOutageState extends Omit<NetworkRetryContext, "signal"> {
  readonly nextRetryAtMs?: number;
  readonly lastDelayMs?: number;
  readonly outageExpiresAtMs?: number;
  readonly lastFailure: NetworkFailureClassification;
}

export type NetworkRecoveryEventType =
  | "outage_started"
  | "retry_scheduled"
  | "retry_started"
  | "retry_failed"
  | "expiry_scheduled"
  | "outage_expired"
  | "recovered"
  | "failed"
  | "cancelled"
  | "cleanup";

export interface NetworkRecoveryEvent {
  readonly type: NetworkRecoveryEventType;
  readonly state: NetworkOutageState;
  /** Present when this event was caused by a newly observed failure. */
  readonly classification?: NetworkFailureClassification;
}

export type NetworkRecoveryJitter = (cappedDelayMs: number, random: () => number, retryCount: number) => number;

export type NetworkRecoverySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface RecoverNetworkOperationOptions<T> {
  /** The transient error observed after Pi's own bounded request retries were exhausted. */
  readonly initialFailure: unknown;
  readonly config: Readonly<NetworkRecoveryConfig>;
  /** A fresh coordinator-level retry. It receives only a network retry count, never an ordinary task attempt. */
  readonly retry: (context: NetworkRetryContext) => Promise<T>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: NetworkRecoverySleep;
  /** Injectable outage-deadline timer, separate from backoff sleep for deterministic tests. */
  readonly deadlineSleep?: NetworkRecoverySleep;
  readonly random?: () => number;
  readonly jitter?: NetworkRecoveryJitter;
  readonly classify?: (error: unknown) => NetworkFailureClassification;
  readonly onEvent?: (event: NetworkRecoveryEvent) => void;
}

export interface NetworkRecoveryOutcome<T> {
  readonly value: T;
  readonly outage: NetworkOutageState;
}

export class NetworkOutageExpiredError extends Error {
  readonly outage: NetworkOutageState;
  readonly lastFailure: unknown;

  constructor(outage: NetworkOutageState) {
    const maximumMs =
      outage.outageExpiresAtMs === undefined ? outage.elapsedMs : outage.outageExpiresAtMs - outage.outageStartedAtMs;
    super(`Network outage exceeded the configured maximum of ${maximumMs}ms.`, {
      cause: outage.lastFailure.error,
    });
    this.name = "NetworkOutageExpiredError";
    this.outage = outage;
    this.lastFailure = outage.lastFailure.error;
  }
}

export class NetworkRecoveryAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(abortMessage(reason), reason instanceof Error ? { cause: reason } : undefined);
    this.name = "AbortError";
    this.reason = reason;
  }
}

/**
 * Equal jitter in the inclusive range [ceil(cappedDelay / 2), cappedDelay].
 * Equal jitter avoids zero-delay retry loops while still spreading probes.
 */
export const equalNetworkRetryJitter: NetworkRecoveryJitter = (cappedDelayMs, random) => {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError("Network recovery random() must return a finite number between 0 and 1.");
  }
  const minimum = Math.ceil(cappedDelayMs / 2);
  return Math.min(cappedDelayMs, minimum + Math.floor(randomValue * (cappedDelayMs - minimum + 1)));
};

/** Calculate a one-based capped exponential delay, then apply and cap jitter. */
export function networkRetryDelayMs(
  retryCount: number,
  config: Pick<NetworkRecoveryConfig, "baseDelayMs" | "maxDelayMs">,
  options: {
    random?: () => number;
    jitter?: NetworkRecoveryJitter;
  } = {},
): number {
  if (!Number.isSafeInteger(retryCount) || retryCount < 1) {
    throw new RangeError("Network recovery retryCount must be a positive safe integer.");
  }

  const exponent = retryCount - 1;
  const exponential = exponent > 1023 ? Number.POSITIVE_INFINITY : config.baseDelayMs * 2 ** exponent;
  const capped = Math.min(config.maxDelayMs, exponential);
  const jittered = (options.jitter ?? equalNetworkRetryJitter)(capped, options.random ?? Math.random, retryCount);
  if (!Number.isFinite(jittered)) {
    throw new RangeError("Network recovery jitter must return a finite delay.");
  }
  return Math.max(0, Math.min(capped, Math.round(jittered)));
}

/**
 * Resume an operation after an already-observed provider/transport failure.
 *
 * The helper owns only its `retryCount`; callers must not increment ordinary
 * task, planner, reviewer, or goal-loop counters while it is running. Every
 * wait and retry is raced with the caller's AbortSignal so cancellation does
 * not depend on an injected sleep or provider callback cooperating.
 */
export async function recoverNetworkOperation<T>(
  options: RecoverNetworkOperationOptions<T>,
): Promise<NetworkRecoveryOutcome<T>> {
  throwIfAborted(options.signal);

  const classify = options.classify ?? classifyNetworkFailure;
  let classification = classify(options.initialFailure);
  if (!options.config.enabled || !classification.recoverable) {
    throw options.initialFailure;
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadlineSleep = options.deadlineSleep ?? abortableSleep;
  const outageStartedAtMs = now();
  const outageExpiresAtMs =
    options.config.maxOutageMs === null ? undefined : outageStartedAtMs + options.config.maxOutageMs;
  let retryCount = 0;
  let networkWaitMs = 0;
  let nextRetryAtMs: number | undefined;
  let lastDelayMs: number | undefined;
  let elapsedMs = 0;
  let terminalEventEmitted = false;

  const state = (): NetworkOutageState => {
    elapsedMs = Math.max(elapsedMs, Math.max(0, now() - outageStartedAtMs));
    return Object.freeze({
      retryCount,
      outageStartedAtMs,
      elapsedMs,
      networkWaitMs,
      nextRetryAtMs,
      lastDelayMs,
      outageExpiresAtMs,
      lastFailure: classification,
    });
  };
  const emit = (type: NetworkRecoveryEventType, causedByFailure = false): NetworkOutageState => {
    const snapshot = state();
    options.onEvent?.({ type, state: snapshot, classification: causedByFailure ? classification : undefined });
    return snapshot;
  };
  const expire = (): never => {
    nextRetryAtMs = undefined;
    terminalEventEmitted = true;
    const snapshot = emit("outage_expired");
    throw new NetworkOutageExpiredError(snapshot);
  };

  const performWait = async (delayMs: number): Promise<void> => {
    const startedAtMs = now();
    try {
      await raceWithAbort(sleep(delayMs, options.signal), options.signal);
    } finally {
      networkWaitMs += Math.max(0, now() - startedAtMs);
    }
  };

  const executeRetry = async (): Promise<T> => {
    const retryStartedAtMs = now();
    const remainingOutageMs =
      outageExpiresAtMs === undefined ? undefined : Math.max(0, outageExpiresAtMs - retryStartedAtMs);
    if (remainingOutageMs === 0) expire();

    const deadlineController = remainingOutageMs === undefined ? undefined : new AbortController();
    const retryController = deadlineController ? new AbortController() : undefined;
    const retrySignal = combineAbortSignals(options.signal, retryController?.signal);
    const operation = Promise.resolve().then(() =>
      options.retry({
        retryCount,
        outageStartedAtMs,
        elapsedMs: state().elapsedMs,
        networkWaitMs,
        signal: retrySignal,
      }),
    );

    if (remainingOutageMs === undefined || !deadlineController || !retryController) {
      return await raceWithAbort(operation, options.signal);
    }

    const deadline = deadlineSleep(remainingOutageMs, deadlineController.signal).then(() => {
      const expired = new NetworkOutageExpiredError(state());
      retryController.abort(expired);
      return expire();
    });
    try {
      return await raceWithAbort(Promise.race([operation, deadline]), options.signal);
    } finally {
      deadlineController.abort("network retry completed");
    }
  };

  try {
    emit("outage_started", true);
    while (true) {
      throwIfAborted(options.signal);
      const beforeDelay = state();
      if (outageExpiresAtMs !== undefined && beforeDelay.elapsedMs > options.config.maxOutageMs!) {
        expire();
      }

      const nextRetryCount = retryCount + 1;
      const desiredDelayMs = networkRetryDelayMs(nextRetryCount, options.config, {
        random: options.random,
        jitter: options.jitter,
      });
      const currentTimeMs = now();
      const remainingOutageMs =
        outageExpiresAtMs === undefined ? undefined : Math.max(0, outageExpiresAtMs - currentTimeMs);

      if (remainingOutageMs !== undefined && desiredDelayMs >= remainingOutageMs) {
        lastDelayMs = remainingOutageMs;
        nextRetryAtMs = undefined;
        emit("expiry_scheduled");
        await performWait(remainingOutageMs);
        expire();
      }

      retryCount = nextRetryCount;
      lastDelayMs = desiredDelayMs;
      nextRetryAtMs = currentTimeMs + desiredDelayMs;
      emit("retry_scheduled");
      await performWait(desiredDelayMs);
      nextRetryAtMs = undefined;

      const afterWait = state();
      if (outageExpiresAtMs !== undefined && afterWait.elapsedMs > options.config.maxOutageMs!) {
        expire();
      }

      emit("retry_started");
      try {
        const value = await executeRetry();
        terminalEventEmitted = true;
        return { value, outage: emit("recovered") };
      } catch (error) {
        if (options.signal?.aborted) throw abortedError(options.signal);
        if (error instanceof NetworkOutageExpiredError) throw error;
        classification = classify(error);
        if (!classification.recoverable) {
          terminalEventEmitted = true;
          emit("failed", true);
          throw error;
        }
        emit("retry_failed", true);
        if (outageExpiresAtMs !== undefined && state().elapsedMs >= options.config.maxOutageMs!) {
          expire();
        }
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      if (!terminalEventEmitted) emit("cancelled");
      throw abortedError(options.signal);
    }
    throw error;
  } finally {
    emit("cleanup");
  }
}

export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });

    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortedError(signal));
    }
  });
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortedError(signal));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (available.length === 0) return undefined;
  if (available.length === 1) return available[0];
  return AbortSignal.any(available);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError(signal);
}

function abortedError(signal?: AbortSignal): NetworkRecoveryAbortedError {
  return new NetworkRecoveryAbortedError(signal?.reason);
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return `Network recovery was aborted: ${reason.message}`;
  if (typeof reason === "string" && reason) return `Network recovery was aborted: ${reason}`;
  return "Network recovery was aborted.";
}
