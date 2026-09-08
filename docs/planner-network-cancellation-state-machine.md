# Planner, network recovery, and cancellation state map

This note records the runtime boundaries used by the coordinator. It is an implementation map, not a public configuration guide.

| Current state     | Event                                    | Next state                                   | Diagnostic                                                                                                 |
| ----------------- | ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Planning          | Per-attempt planning deadline reached    | Grace (when configured), otherwise timed out | `timeout` only after grace cannot produce a safe valid plan                                                |
| Grace             | Safe, complete TODO output settles       | Complete                                     | No terminal error                                                                                          |
| Grace             | Grace expires                            | Timed out                                    | `timeout`, with partial-output presence                                                                    |
| Planning or grace | Caller abort signal                      | Cancelled immediately                        | `cancelled`, with partial-output presence; never `timeout`                                                 |
| Planning          | Recoverable provider/transport failure   | Network recovery                             | `network_recovery` plus a separate `network_wait` progress event                                           |
| Network recovery  | Backoff completes                        | Fresh planner provider attempt               | The configured per-attempt planner deadline is reused unchanged                                            |
| Network recovery  | Retry succeeds                           | Planning/complete                            | `network_recovery` (`recovered`)                                                                           |
| Network recovery  | Outage expires or retry becomes terminal | Failed                                       | `network_failure`, unless the retry itself ended with a planner `timeout` or caller `cancelled` diagnostic |
| Network recovery  | Caller abort signal                      | Cancelled immediately                        | `cancelled`; network emits lifecycle cleanup but not a planner timeout/network failure                     |

## Clock ownership

- The **planner clock** bounds each provider attempt and optionally transitions into its grace period.
- The **grace clock** starts only after that attempt's planner deadline and exists only to collect a safe completed plan.
- The **network outage clock** bounds coordinator recovery and backoff. Network wait is deliberately excluded from the per-attempt planner clock.
- A retry receives the exact same configured planner timeout; network settings cannot replace, shorten, or enlarge it. Because outage wait and retries add wall-clock time, progress messages and structured fields expose the policy as `per_attempt_excludes_network_wait` rather than silently presenting recovery as planner time.
- The **caller cancellation signal** has priority over planning, grace, and recovery. Cancellation resolves the guard promptly and is not inferred from timeout text.

Partial planner text is never copied into diagnostics. Only the safe boolean `partialOutputObserved` is retained on timeout, cancellation, and prompt/network failure diagnostics when known.
