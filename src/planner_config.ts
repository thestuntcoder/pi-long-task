export const MAX_PLANNER_DURATION_MS = 2_147_483_647;

export class PlannerDurationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerDurationConfigError";
  }
}

export function resolvePlannerTimeoutMs(value: number | undefined, fallback: number): number {
  return resolvePlannerDurationMs(value, fallback, "TODO planner timeout", false);
}

export function resolvePlannerGracefulShutdownMs(value: number | undefined, fallback: number): number {
  return resolvePlannerDurationMs(value, fallback, "TODO planner graceful-shutdown duration", true);
}

export function validatePlannerTimeoutMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : resolvePlannerTimeoutMs(value, value);
}

export function validatePlannerGracefulShutdownMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : resolvePlannerGracefulShutdownMs(value, value);
}

function resolvePlannerDurationMs(
  value: number | undefined,
  fallback: number,
  label: string,
  allowZero: boolean,
): number {
  if (value === undefined) {
    return fallback;
  }

  const minimumDescription = allowZero ? "a non-negative" : "a positive";
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (!allowZero && value <= 0) ||
    (allowZero && value < 0) ||
    value > MAX_PLANNER_DURATION_MS
  ) {
    throw new PlannerDurationConfigError(
      `${label} must be ${minimumDescription} whole-millisecond duration no greater than about 24.9 days (${MAX_PLANNER_DURATION_MS} milliseconds); received ${String(value)}.`,
    );
  }

  return value;
}
