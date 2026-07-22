# Pi Long Task release-review baseline

Baseline captured on 2026-07-22 for the review that starts from release `v0.3.12` (`e1eb16d`). This document establishes the review boundary and records observed behavior; it is not a release-readiness decision.

## Review scope

The follow-on review covers:

- correctness of TODO planning/normalization, parsing, sequential execution, retries, cancellation, timeout handling, result parsing, and optional commits;
- correctness of the iterative goal loop, including discovery, generated TODO execution, review, persisted state, limits, and cancellation;
- compatibility of the extension manifest, Pi extension hooks, custom tools/renderers, TUI sidebar, and isolated SDK worker sessions;
- regression coverage for success, failure, malformed input, interruption, retry, state persistence, and commit safety;
- package/release metadata, documented behavior, package contents, and native smoke behavior.

Unrelated product changes and feature expansion are outside this review. Confirmed fixes should remain minimal and preserve the documented interfaces unless a defect requires a documented change.

## Repository and environment baseline

- Git began clean on `main`, aligned with `origin/main`, at tagged release `v0.3.12`.
- The latest behavioral commit is `b43f1f2` (`Support Pi ModelRuntime worker sessions`); `e1eb16d` only updates release versions to `0.3.12`.
- The preceding release line added goal-loop discovery/specification support and minimum-iteration controls.
- No `AGENTS.md` exists in this repository.
- npm is the package manager: `package-lock.json` is lockfile version 3 and identifies package version `0.3.12`.
- Baseline toolchain: Node.js `v22.22.3`, npm `10.9.8`, Pi `0.81.1`; installed Pi SDK/TUI packages are `0.81.1`.
- `package.json` declares ESM (`"type": "module"`) but no Node `engines` or OS restriction. Development tests use Node's `--experimental-strip-types`; the distributed extension is loaded directly from TypeScript by Pi.
- Runtime Pi packages and `typebox` are wildcard peer dependencies, as recommended for Pi package-provided core modules. Development dependencies pin the current review line at `^0.81.1`.
- The README documents `ModelRuntime` for Pi 0.80.8 and newer plus a legacy auth/model-registry fallback for older compatible Pi releases. It does not claim an exact oldest Pi or Node version.
- Native operation requires the Pi CLI and, for commit mode, Git. The native smoke test additionally requires usable model credentials. TUI progress is optional; partial tool updates and final results remain available in headless modes.

## Package and extension entry points

`package.json` has no conventional JavaScript `main` export. Pi loads `./src/index.ts` through `pi.extensions`, and the published file allowlist includes `src`, `scripts`, `README.md`, and `LICENSE`. This matches the installation and local-loading instructions in `README.md`.

The default factory in `src/index.ts` registers:

- a `message_end` hook that adds isolated worker/reviewer cost to a later parent assistant message;
- an `input` hook that routes eligible natural-language requests without intercepting informational, negated, explicit-tool, or extension-injected input;
- `pi_long_task`, with `{ commit, inputText?, goal? }`;
- `pi_goal_task`, with a required goal, optional commit control, and iteration/timeout safety limits.

Both tools provide custom call/result renderers. `pi_long_task` streams coordinator updates to the main tool result. In TUI mode, both tools also update a right-side non-capturing overlay with a widget fallback; cleanup occurs in `finally`. JSON/print modes do not create that TUI controller.

## Long-task lifecycle

1. `src/input_router.ts` optionally transforms natural-language input into an explicit tool-use instruction.
2. `src/coordinator.ts` creates `tmp/pi-long-task/<run-id>/`, initializes `TASK_RESULT.md`, and either normalizes supplied TODO markdown/list input or asks an isolated planner session to create a plan.
3. `src/todo_generator.ts` validates the plan shape. Invalid planner output gets one repair attempt; planner timeout, abort, and diagnostics are surfaced and persisted.
4. `src/todo_parser.ts` parses sequential TODO sections, global progress, and each task's `**Status:**` checklist.
5. The coordinator selects the first unfinished task and `src/worker_session.ts` creates a fresh in-memory Pi SDK session with built-in coding tools and extensions disabled. Workers receive only the assigned task, global instructions, goal, attempt history, commit mode, and safety limits.
6. Worker events feed partial progress and cost accounting. A missing `TASK_RESULT` status gets one follow-up request. Successful tasks are marked complete; unfinished tasks retry up to the configured limit.
7. In commit mode, `src/git.ts` commits only eligible task changes after excluding generated artifacts and paths dirty before that attempt.
8. `src/result_writer.ts`, coordinator summaries, and the parsed TODO produce final counts, status, remaining tasks, attempt history, costs, and artifact paths.

Default coordinator limits are three attempts, 15 minutes per task, five minutes for planning plus 15 seconds of graceful shutdown, and five minutes maximum requested bash timeout. Tasks execute sequentially.

## Goal-loop lifecycle and state

`src/goal_orchestrator.ts` backs `pi_goal_task`:

1. create and persist versioned goal-loop state under `tmp/pi-goal-task/<goal-run-id>/`;
2. classify vague goals for discovery while preserving direct behavior for concrete goals;
3. optionally persist `GOAL_SPEC.json` with requirements, milestones, acceptance criteria, verification gates, constraints, and definition-of-done;
4. generate implementation TODO markdown through a child long-task run;
5. execute that TODO through another child coordinator run;
6. run a separate SDK reviewer session and record `complete`, `incomplete`, `blocked`, or `failed`;
7. repeat until review completion and minimum iterations, cancellation, timeout, or maximum iterations.

The default goal-loop limits are 1 minimum iteration, 50 maximum iterations, 48 hours overall, 3 hours per implementation iteration, and 30 minutes per review. Goal loops default to commit mode; direct long tasks require an explicit boolean and natural-language routing defaults them to no commits.

Durable goal state consists of `GOAL_STATE.json`, append-only `GOAL_TRACE.jsonl`, `GOAL_RESULT.md`, optional `GOAL_SPEC.json`, per-iteration snapshots/payloads/raw outputs, worker progress JSONL, and nested long-task artifacts. Atomic replacement is used for goal state/specification JSON. In-memory coordinator state tracks attempts, outcomes, commit summaries, live/final worker cost, and sidebar snapshots; durable TODO/result files remain the run record.

## User-facing behavior

- Natural-language long-task and goal-loop requests are routed to the corresponding tool, including commit, goal, and iteration modifiers.
- Users can also invoke either tool explicitly.
- Active runs expose main-thread partial tool updates, compact custom rendering, TUI task/subtask progress when available, final aggregate status, artifact paths, worker/reviewer cost when reported, and commit hashes when created.
- Worker `done` is determined from the final machine-readable `TASK_RESULT` status, not merely process completion.
- Generated artifacts live under ignored `tmp/` paths and are excluded from extension-created commits.

## Validation commands

`package.json` exposes:

| Command                | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `npm test`             | Node test runner over TypeScript using strip-types                                  |
| `npm run typecheck`    | TypeScript `--noEmit`                                                               |
| `npm run lint`         | ESLint                                                                              |
| `npm run format:check` | Prettier verification                                                               |
| `npm run check`        | format check, lint, typecheck, then all tests                                       |
| `npm run smoke:native` | credentialed native Pi smoke in disposable Git repositories, with commit off and on |

There is no build script because Pi loads the TypeScript extension directly.

## Baseline results

- `git status --short --branch` — clean `main...origin/main` before validation.
- `npm run check` — passed: formatting, lint, typecheck, and 25 Node test-runner tests (25 passed, 0 failed, 0 skipped).
- `PI_OFFLINE=1 pi --mode json --no-extensions -e /Users/dj/Sites/pi-coordinator --no-session` — exited successfully and emitted a JSON session event, confirming package-manifest discovery and extension activation on Pi 0.81.1.
- `npm ls --depth=0` — exited successfully; declared top-level dependencies resolve at the expected versions. npm also reports 15 transitive modules as extraneous in the existing development `node_modules`, which does not affect the locked dependency graph or `npm run check`.
- `npm run smoke:native` — not run for this baseline because it invokes paid/credentialed model sessions. It remains a required release-readiness check when credentials are intentionally available.

The automated baseline is green, but release readiness is intentionally undecided until the correctness, compatibility, regression, package, and native-smoke reviews are complete.

## Pi references consulted

Compatibility expectations were established against the installed Pi 0.81.1 documentation for extensions, packages, SDK sessions/`ModelRuntime`, and TUI components, plus the input-transform, tool-rendering/state, plan-mode widget, and overlay examples. The observed manifest entry point, extension hooks, tool signatures, partial updates, mode guards, worker session creation, and package peer-dependency layout correspond to those documented integration points; detailed compatibility assessment belongs to the dedicated compatibility review.
