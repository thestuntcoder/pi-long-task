# Changelog

Notable changes to Pi Long Task are recorded here. This project follows semantic versioning.

## 0.7.0 - 2026-09-08

### Added

- Expose optional `todoTimeoutMs` and `todoGracefulShutdownMs` settings on both tools and their goal-loop plumbing, with friendly natural-language/global directives and structured-option precedence.
- Add deterministic adaptive TODO-planner budgets: a 5-minute base for up to four detected items, 30 seconds per additional item, and a 15-minute cap for explicit item counts, enumerated deliverables, or separately planned tasks.
- Report effective planner budgets, adaptive reasons, bounded elapsed/remaining updates, and grace-period entry consistently across TUI, CLI/headless progress, structured results, and run diagnostics.
- Warn when requests explicitly require Chrome/browser extensions or direct tools unavailable to isolated workers, constrain generated plans to available alternatives, and require blocked results when the exact capability is mandatory.
- Record whether partial planner output was observed on timeout or cancellation without exposing its content, and distinguish planner network-recovery lifecycle data from deadline failures.

### Changed

- Use `high` instead of `xhigh` as the planner-only default thinking level, while forwarding every explicit programmatic thinking override unchanged.
- Make creation and repair prompts concise and planning-only so planners preserve constraints without performing implementation, research, or creative deliverables.
- Continue observing a stopping planner during the configured grace period and accept only a safe, complete, valid TODO plan that settles there.
- Keep planner deadlines, grace periods, network outage recovery, and caller cancellation on distinct clocks and diagnostic paths. Network waits do not mutate the configured per-attempt planning budget, and cancellation is never reported as timeout.

### Compatibility

- Existing `pi_long_task`, `pi_goal_task`, `runCoordinator()`, and direct planner calls remain valid when the new options are omitted; defaults and result/schema additions are backward-compatible.
- Explicit timeout and grace values remain authoritative, including explicit `xhigh` planner thinking for programmatic callers. Existing worker, goal-discovery, reviewer, attempt, and network-recovery defaults are unchanged.

## 0.6.0 - 2026-09-05

### Added

- Add opt-in coordinator-level recovery after Pi exhausts its bounded provider retries, with configurable jittered backoff, a bounded five-minute outage window by default, and an indefinite wait-until-cancelled mode.
- Show `Waiting for connection…` lifecycle status with retry and outage timing across worker, TODO planning, steering, goal planning/discovery, and review operations.
- Classify transient transport, timeout, stream, overload, rate-limit, and retryable server failures while failing fast for authentication, authorization, billing, quota, invalid request/model, certificate, cancellation, and unknown failures.

### Changed

- Preserve TODO identity, ordinary attempt counts, durable evidence, accepted steering, working-tree changes, goal-loop state, and cost accounting while network recovery is active.
- Exclude network-recovery time and retries from worker, planner, reviewer, goal-loop timeout and retry budgets; rotate interrupted sessions before safely resuming the same operation.

### Security and reliability

- Prevent blind replay of completed side-effectful worker actions by recording interruption evidence and requiring fresh continuation sessions to inspect durable state before acting.
- Keep cancellation immediate during backoff and retry execution, with exact-once cleanup of recovery timers, listeners, sessions, and status resources.

## 0.5.0 - 2026-08-31

### Added

- Adaptively reuse healthy, compatible worker sessions for related sequential TODOs, with explicit assignment boundaries and a conservative 62.5% default context threshold.
- Expose worker-session start, reuse, retention, rotation, context-usage, and reason diagnostics through progress updates, task artifacts, and coordinator metrics.

### Changed

- Attribute cumulative reused-session cost and token statistics as task/attempt-level deltas across reuse, retries, counter resets, and rotations.
- Rotate to fresh sessions after unsafe outcomes, incompatible configuration, unavailable or excessive context usage, and independent retries; reuse may be disabled to retain isolated assignment behavior.

### Fixed

- Collapse repeated `Finished:` and `Failed:` prefixes defensively in both active-status renderers.

## 0.4.0 - 2026-08-31

### Added

- Accept additional plain-text guidance while a long task is running and incorporate queued messages into revised TODO plans.
- Preserve completed work across plan revisions using stable task identities, while scheduling corrective follow-up work when guidance invalidates prior results.
- Atomically persist and re-render revised plans, continue from the next eligible task, and prevent obsolete in-flight workers from completing replacement tasks.
- Report accepted and rejected revisions through live progress, retaining the current plan when revision generation or validation fails.

## 0.3.17 - 2026-08-26

### Fixed

- Prevent repeated `Finished:` and `Failed:` prefixes from accumulating in the sidebar's active status across tool events.
- Reset the active status at every tool start so a completed tool's status cannot leak into the next tool.

## 0.3.16 - 2026-08-20

### Changed

- Make the sidebar's "Active status" follow live worker commentary and tool activity instead of repeating a generic coordinator message.
- Show active bash commands and read, edit, and write paths, including tool completion or failure state.
- Preserve the latest worker activity across unrelated cost updates while keeping the compact fallback layout unchanged.

## 0.3.15 - 2026-08-20

### Changed

- Show the full active task status in a dedicated "Active status" section below the active task in the TUI sidebar, wrapping instead of truncating long status messages.
- Wrap the active task status message and current task line in the plain widget fallback instead of hard-truncating them.

## 0.3.14 - 2026-08-20

### Documentation and metadata

- Improve npm and GitHub discoverability with a richer package description, expanded keywords, and added `repository`, `homepage`, `bugs`, and `engines` fields.
- Add npm version, Node.js, and license badges, a keyword-rich introduction, and the embedded package preview image to the README.

## 0.3.13 - 2026-07-22

### Fixed

- Require complete, machine-readable worker results and reject false completion after session errors, timeouts, or cancellation.
- Bound worker and reviewer cancellation even when an SDK prompt or graceful follow-up does not settle.
- Preserve checked TODO progress, durable attempt ordering, retry commit baselines, and accurate failure evidence.
- Resume persisted goal-loop phases without repeating completed generation or execution work.
- Enforce overall and iteration deadlines consistently across generation, execution, and review.
- Retain structured terminal goal results and persisted cost totals across cancellation, failure, and resume paths.

### Compatibility and maintenance

- Declare the supported Node.js floor as 22.19.0 and document validation against Pi 0.80.7, 0.80.8, and 0.81.1.
- Refresh the controllable transitive development lockfile resolutions for `brace-expansion` and `protobufjs`.
