# Planner vs worker lifecycle audit

This note records the pre-refactor behavior difference between `runWorkerTask()` and `runTodoPlanner()`.
It is intended to guide the shared session-guard work without changing the public `pi_long_task` tool interface.

## What `runWorkerTask()` handles that `runTodoPlanner()` does not

| Area                  | Worker lifecycle behavior                                                                                                                                                                                                      | Current planner gap                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout               | Schedules `taskTimeoutSeconds`; sends a graceful time-limit prompt; optionally aborts after `gracefulShutdownSeconds`; clears timers in `finally`.                                                                             | No planner timeout and no timer cleanup because no timer exists; a hanging `session.prompt()` can block planning indefinitely.                                                           |
| Abort                 | Checks `AbortSignal` before session creation work continues; registers an abort listener while the prompt is running; calls `session.abort()`; records `aborted`/`error`; removes the listener in `finally`.                   | Checks `AbortSignal` only after the session is created and before `prompt()`; no listener while `prompt()` is pending and no `session.abort()` call.                                     |
| Disposal and cleanup  | Unsubscribes event listener, removes abort listener, clears timers, captures latest session identifiers/text/stats, and always calls `dispose()` when a session exists.                                                        | Only calls `dispose()` when a session exists. No subscription, abort listener, timer, stats, or final event/text cleanup.                                                                |
| Event capture         | Subscribes to session events; stores summarized events; streams worker event progress via `onEvent`; tracks assistant deltas/message ends/turn ends/agent ends; records context, compaction, extension, bash, and cost events. | Does not subscribe to events. It cannot recover final text that is only present in events and does not expose planning diagnostics/progress from events.                                 |
| Diagnostics           | Preserves factory `modelFallbackMessage` and extension diagnostics in `contextObservations`; records timeout/abort/session errors; synthesizes a failure `TASK_RESULT` if needed.                                              | Ignores factory fallback/diagnostics; thrown errors are not augmented with planner session diagnostics; no planner failure artifact details beyond the coordinator catch message.        |
| Final text extraction | Maintains assistant text from streaming deltas and terminal events, then re-checks `getLastAssistantText()` and `session.messages` in `finally`. If the worker omitted `TASK_RESULT`, asks once for the required block.        | Extracts only after `prompt()` from `getLastAssistantText()` or `session.messages`. It does not use event-derived text and has no retry/repair path for empty or invalid planner output. |
| Worker safeguards     | Enforces max bash timeout via `abortBash()` and asks for safe task-result shutdown.                                                                                                                                            | Not applicable to the planner because it runs with `tools: []` and should not produce worker task-result blocks.                                                                         |

## Reusable lifecycle behavior

A shared helper for one guarded model prompt should cover:

- bounded execution with a hard timeout and cleanup of timers;
- `AbortSignal` pre-check plus an in-flight listener that calls `session.abort()`;
- deterministic teardown: unsubscribe, remove abort listener, clear timers, and `dispose()`;
- final assistant text extraction from events, `getLastAssistantText()`, and `session.messages`;
- structured outcome fields such as `assistantText`, `timedOut`, `aborted`, `error`, `sessionFile`, `sessionId`, and diagnostics;
- optional event capture so the worker can keep its existing progress behavior while the planner can surface planning diagnostics.

## Behavior that should remain worker-only

- Assigned-task prompt construction and `TASK_RESULT` parsing/status derivation.
- The missing-`TASK_RESULT` follow-up prompt and synthesized worker failure `TASK_RESULT`.
- Bash-specific enforcement (`maxBashTimeoutSeconds`, `abortBash()`) and worker tool progress updates.
- Worker cost accounting and task attempt/session outcome fields unless planner cost is intentionally added later.
- Commit-related eligibility remains based on worker `SessionOutcome`, not planner output.

## Refactor direction

Keep `runTodoPlanner()` behavior backward-compatible at the public interface, but route its single prompt through the shared guarded helper.
Planner-specific code should validate/extract TODO markdown and, in later robustness work, repair invalid planner output once.
Worker-specific task result enforcement and bash safeguards should stay in `runWorkerTask()` around the shared prompt lifecycle.
