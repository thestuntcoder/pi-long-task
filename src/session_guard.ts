import {
  assistantTextFromEvent,
  lastAssistantTextFromEvents,
  lastAssistantTextFromMessages,
  type WorkerSessionLike,
} from "./worker_session.ts";

export interface GuardedSessionPromptOptions {
  session: WorkerSessionLike;
  prompt: string;
  promptOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  gracefulShutdownMs?: number;
  gracefulShutdownPrompt?: string;
  diagnostics?: string[];
  onEvent?: (event: unknown) => void;
  /** Bounded elapsed-time checkpoints while the primary deadline is active. */
  progressCheckpointsMs?: readonly number[];
  onProgressCheckpoint?: (elapsedMs: number) => void;
  /** Called exactly when a positive grace period begins. */
  onGracePeriodStart?: (gracePeriodMs: number) => void;
  dispose?: boolean;
}

export interface GuardedSessionPromptResult {
  assistantText: string;
  /** True when the primary prompt deadline elapsed, even if the prompt safely completed during grace. */
  timedOut: boolean;
  /** True only when a timed-out prompt settled during the configured grace period. */
  completedDuringGrace: boolean;
  /** True when non-whitespace assistant output was observed before prompt termination. */
  outputObserved: boolean;
  /** True when the session had to be stopped because its grace period expired. */
  graceExpired: boolean;
  /** True when the session was stopped for any reason, including hard timeout. */
  aborted: boolean;
  /** True only when the caller's AbortSignal cancelled the prompt. */
  cancelled: boolean;
  error?: string;
  /** Untouched prompt failure for coordinator-level provider/transport classification. */
  failure?: unknown;
  diagnostics: string[];
  events: unknown[];
  sessionFile?: string;
  sessionId?: string;
}

export async function runGuardedSessionPrompt(
  options: GuardedSessionPromptOptions,
): Promise<GuardedSessionPromptResult> {
  const session = options.session;
  const diagnostics = [...(options.diagnostics ?? [])];
  const events: unknown[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let assistantText = "";
  let currentAssistantText = "";
  let outputObserved = false;
  let timedOut = false;
  let graceExpired = false;
  let aborted = false;
  let cancelled = false;
  let error: string | undefined;
  let failure: unknown;
  let promptSettled = false;
  let finished = false;
  let unsubscribe: (() => void) | undefined;
  let complete: (() => void) | undefined;
  const assistantTextAtStart = latestAssistantText(session, [], "");

  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });

  const resolveCompleted = () => {
    complete?.();
    complete = undefined;
  };

  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  const schedule = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const abortSession = (reason: string) => {
    if (finished || aborted) {
      return;
    }
    aborted = true;
    error = error ?? reason;
    try {
      const abortResult = session.abort?.();
      if (isPromiseLike(abortResult)) {
        void abortResult.catch((exc: unknown) => {
          diagnostics.push(`session abort failed: ${errorMessage(exc)}`);
        });
      }
    } catch (exc) {
      diagnostics.push(`session abort failed: ${errorMessage(exc)}`);
    }
  };

  const notifyTiming = (callback: (() => void) | undefined, label: string) => {
    try {
      callback?.();
    } catch (exc) {
      diagnostics.push(`${label} listener failed: ${errorMessage(exc)}`);
    }
  };

  const requestGracefulShutdown = () => {
    const message = options.gracefulShutdownPrompt?.trim();
    if (!message || finished || promptSettled || aborted) {
      return;
    }

    try {
      if (session.isBashRunning && session.abortBash) {
        session.abortBash();
        diagnostics.push("aborted running bash before graceful shutdown request");
      }

      let request: Promise<unknown> | undefined;
      if ((session.isStreaming || session.isBashRunning) && session.steer) {
        request = session.steer(message);
      } else if (session.followUp) {
        request = session.followUp(message);
      } else if (session.steer) {
        request = session.steer(message);
      }

      if (!request) {
        diagnostics.push("graceful shutdown request skipped: session does not support steer/followUp");
        return;
      }

      void request.catch((exc: unknown) => {
        diagnostics.push(`graceful shutdown request failed: ${errorMessage(exc)}`);
      });
    } catch (exc) {
      diagnostics.push(`graceful shutdown request failed: ${errorMessage(exc)}`);
    }
  };

  const triggerTimeout = () => {
    if (finished || promptSettled || timedOut) {
      return;
    }
    timedOut = true;
    diagnostics.push(`session prompt timed out after ${formatMilliseconds(timeoutMs(options.timeoutMs))}`);

    const graceMs = nonNegativeMilliseconds(options.gracefulShutdownMs);
    if (graceMs > 0) {
      notifyTiming(() => options.onGracePeriodStart?.(graceMs), "grace-period progress");
    }
    requestGracefulShutdown();

    const hardAbort = () => {
      if (finished || promptSettled) {
        return;
      }
      graceExpired = true;
      abortSession(`session prompt exceeded ${formatMilliseconds(timeoutMs(options.timeoutMs))} timeout`);
      resolveCompleted();
    };

    if (graceMs > 0) {
      schedule(hardAbort, graceMs);
    } else {
      hardAbort();
    }
  };

  const abortListener = () => {
    if (finished || promptSettled) {
      return;
    }
    cancelled = true;
    abortSession(abortReason(options.abortSignal, "session prompt cancelled by outer signal"));
    resolveCompleted();
  };

  try {
    if (options.abortSignal?.aborted) {
      aborted = true;
      cancelled = true;
      error = abortReason(options.abortSignal, "session prompt cancelled before start");
    } else {
      unsubscribe = session.subscribe((event: unknown) => {
        events.push(event);
        if (isAssistantMessageStart(event)) {
          currentAssistantText = "";
        }
        const delta = assistantTextDeltaFromEvent(event);
        if (delta !== undefined) {
          currentAssistantText += delta;
          assistantText = currentAssistantText || assistantText;
          outputObserved ||= delta.trim().length > 0;
        } else {
          const text = assistantTextFromEvent(event);
          if (text) {
            currentAssistantText = text;
            assistantText = text;
            outputObserved ||= text.trim().length > 0;
          }
        }
        try {
          options.onEvent?.(event);
        } catch (exc) {
          diagnostics.push(`event listener failed: ${errorMessage(exc)}`);
        }
      });

      options.abortSignal?.addEventListener("abort", abortListener, { once: true });

      const promptPromise = session.prompt(options.prompt, options.promptOptions).then(
        () => {
          promptSettled = true;
          resolveCompleted();
        },
        (exc: unknown) => {
          promptSettled = true;
          failure ??= exc;
          error = error ?? errorMessage(exc);
          resolveCompleted();
        },
      );
      void promptPromise;

      const limitMs = timeoutMs(options.timeoutMs);
      if (limitMs > 0) {
        for (const checkpoint of normalizedProgressCheckpoints(options.progressCheckpointsMs, limitMs)) {
          schedule(() => {
            if (!finished && !promptSettled && !timedOut && !aborted) {
              notifyTiming(() => options.onProgressCheckpoint?.(checkpoint), "timing progress");
            }
          }, checkpoint);
        }
        schedule(triggerTimeout, limitMs);
      }

      await completed;
    }
  } catch (exc) {
    failure ??= exc;
    error = error ?? errorMessage(exc);
  } finally {
    finished = true;
    clearTimers();
    options.abortSignal?.removeEventListener("abort", abortListener);
    unsubscribe?.();
    assistantText = latestAssistantText(session, events, assistantText);
    outputObserved ||= assistantText.trim().length > 0 && assistantText !== assistantTextAtStart;
    if (options.dispose !== false) {
      try {
        const disposeResult = (session.dispose as (() => unknown) | undefined)?.();
        if (isPromiseLike(disposeResult)) {
          await disposeResult;
        }
      } catch (exc) {
        const message = `session dispose failed: ${errorMessage(exc)}`;
        diagnostics.push(message);
        error = error ?? message;
      }
    }
  }

  return buildResult(
    session,
    events,
    assistantText,
    timedOut,
    timedOut && promptSettled && !graceExpired && !aborted && failure === undefined,
    outputObserved,
    graceExpired,
    aborted,
    cancelled,
    error,
    failure,
    diagnostics,
  );
}

function buildResult(
  session: WorkerSessionLike,
  events: unknown[],
  assistantText: string,
  timedOut: boolean,
  completedDuringGrace: boolean,
  outputObserved: boolean,
  graceExpired: boolean,
  aborted: boolean,
  cancelled: boolean,
  error: string | undefined,
  failure: unknown,
  diagnostics: string[],
): GuardedSessionPromptResult {
  return {
    assistantText: latestAssistantText(session, events, assistantText),
    timedOut,
    completedDuringGrace,
    outputObserved,
    graceExpired,
    aborted,
    cancelled,
    error,
    ...(failure === undefined ? {} : { failure }),
    diagnostics: [...diagnostics],
    events: [...events],
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
  };
}

function latestAssistantText(session: WorkerSessionLike, events: unknown[], fallback: string): string {
  const direct = session.getLastAssistantText?.();
  if (direct) {
    return direct;
  }
  const fromMessages = lastAssistantTextFromMessages(session.messages);
  if (fromMessages) {
    return fromMessages;
  }
  const fromEvents = lastAssistantTextFromEvents(events);
  return fromEvents || fallback;
}

function timeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, value);
}

function normalizedProgressCheckpoints(values: readonly number[] | undefined, limitMs: number): number[] {
  if (!values) {
    return [];
  }
  return [...new Set(values)]
    .filter((value) => Number.isFinite(value) && value > 0 && value < limitMs)
    .map((value) => Math.floor(value))
    .sort((left, right) => left - right);
}

function nonNegativeMilliseconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, value);
}

function formatMilliseconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

function isAssistantMessageStart(event: unknown): boolean {
  return (
    isRecord(event) && event.type === "message_start" && isRecord(event.message) && event.message.role === "assistant"
  );
}

function assistantTextDeltaFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "message_update" || !isRecord(event.assistantMessageEvent)) {
    return undefined;
  }
  const assistantEvent = event.assistantMessageEvent;
  return assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string"
    ? assistantEvent.delta
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortReason(signal: AbortSignal | undefined, fallback: string): string {
  const reason = signal?.reason;
  if (reason === undefined) {
    return fallback;
  }
  return errorMessage(reason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
