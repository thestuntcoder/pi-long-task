export const NETWORK_RECOVERY_TIMEOUT_POLICY = "exclude-network-wait" as const;

/**
 * User-provided coordinator network recovery settings. `maxOutageMs: null` is
 * the only unlimited mode: recovery continues until the run is cancelled.
 */
export interface NetworkRecoveryConfigInput {
  enabled?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxOutageMs?: number | null;
}

/**
 * Fully normalized settings shared by every coordinator provider operation.
 *
 * Timeout policy: time spent waiting for network recovery is accounted for
 * separately and does not consume worker, TODO-planner, reviewer, goal-loop,
 * or goal-iteration timeout budgets. It also does not consume their ordinary
 * attempt/retry/iteration limits. The bounded maxOutageMs (or cancellation in
 * unlimited mode) is the sole limit while connectivity is unavailable.
 */
export interface NetworkRecoveryConfig {
  readonly enabled: boolean;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxOutageMs: number | null;
  readonly timeoutPolicy: typeof NETWORK_RECOVERY_TIMEOUT_POLICY;
}

/** Disabled by default to preserve pre-recovery coordinator behavior. */
export const DEFAULT_NETWORK_RECOVERY_CONFIG: Readonly<NetworkRecoveryConfig> = Object.freeze({
  enabled: false,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxOutageMs: 5 * 60_000,
  timeoutPolicy: NETWORK_RECOVERY_TIMEOUT_POLICY,
});

export class NetworkRecoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkRecoveryConfigError";
  }
}

export function resolveNetworkRecoveryConfig(
  input: NetworkRecoveryConfigInput | undefined = {},
): NetworkRecoveryConfig {
  const enabled = input.enabled ?? DEFAULT_NETWORK_RECOVERY_CONFIG.enabled;
  if (typeof enabled !== "boolean") {
    throw new NetworkRecoveryConfigError("networkRecovery.enabled must be a boolean.");
  }

  const baseDelayMs = input.baseDelayMs ?? DEFAULT_NETWORK_RECOVERY_CONFIG.baseDelayMs;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_NETWORK_RECOVERY_CONFIG.maxDelayMs;
  const maxOutageMs = input.maxOutageMs === undefined ? DEFAULT_NETWORK_RECOVERY_CONFIG.maxOutageMs : input.maxOutageMs;

  assertPositiveMilliseconds("networkRecovery.baseDelayMs", baseDelayMs);
  assertPositiveMilliseconds("networkRecovery.maxDelayMs", maxDelayMs);
  if (maxDelayMs < baseDelayMs) {
    throw new NetworkRecoveryConfigError(
      "networkRecovery.maxDelayMs must be greater than or equal to networkRecovery.baseDelayMs.",
    );
  }

  if (maxOutageMs !== null) {
    assertPositiveMilliseconds("networkRecovery.maxOutageMs", maxOutageMs);
    if (maxOutageMs < baseDelayMs) {
      throw new NetworkRecoveryConfigError(
        "networkRecovery.maxOutageMs must be null (unlimited) or greater than or equal to networkRecovery.baseDelayMs.",
      );
    }
  }

  return Object.freeze({
    enabled,
    baseDelayMs,
    maxDelayMs,
    maxOutageMs,
    timeoutPolicy: NETWORK_RECOVERY_TIMEOUT_POLICY,
  });
}

function assertPositiveMilliseconds(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new NetworkRecoveryConfigError(`${name} must be a positive, finite, safe integer number of milliseconds.`);
  }
}
