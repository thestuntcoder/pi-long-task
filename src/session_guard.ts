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
  dispose?: boolean;
}

export interface GuardedSessionPromptResult {
  assistantText: string;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
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
  let timedOut = false;
  let aborted = false;
  let error: string | undefined;
  let promptSettled = false;
  let finished = false;
  let unsubscribe: (() => void) | undefined;
  let complete: (() => void) | undefined;

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
    requestGracefulShutdown();

    const graceMs = nonNegativeMilliseconds(options.gracefulShutdownMs);
    const hardAbort = () => {
      if (finished || promptSettled) {
        return;
      }
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
    abortSession(abortReason(options.abortSignal, "session prompt aborted by outer signal"));
    resolveCompleted();
  };

  try {
    if (options.abortSignal?.aborted) {
      aborted = true;
      error = abortReason(options.abortSignal, "session prompt aborted before start");
    } else {
      unsubscribe = session.subscribe((event: unknown) => {
        events.push(event);
        const text = assistantTextFromEvent(event);
        if (text) {
          assistantText = text;
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
          error = error ?? errorMessage(exc);
          resolveCompleted();
        },
      );
      void promptPromise;

      const limitMs = timeoutMs(options.timeoutMs);
      if (limitMs > 0) {
        schedule(triggerTimeout, limitMs);
      }

      await completed;
    }
  } catch (exc) {
    error = error ?? errorMessage(exc);
  } finally {
    finished = true;
    clearTimers();
    options.abortSignal?.removeEventListener("abort", abortListener);
    unsubscribe?.();
    assistantText = latestAssistantText(session, events, assistantText);
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

  return buildResult(session, events, assistantText, timedOut, aborted, error, diagnostics);
}

function buildResult(
  session: WorkerSessionLike,
  events: unknown[],
  assistantText: string,
  timedOut: boolean,
  aborted: boolean,
  error: string | undefined,
  diagnostics: string[],
): GuardedSessionPromptResult {
  return {
    assistantText: latestAssistantText(session, events, assistantText),
    timedOut,
    aborted,
    error,
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

function nonNegativeMilliseconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, value);
}

function formatMilliseconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
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
