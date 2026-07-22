# Pi Long Task correctness audit

Audit date: 2026-07-22. Scope is TODO parsing/planning, direct long-task execution, task progress and results, isolated session lifecycle, cancellation/interruption, persisted goal-loop state, and resume behavior. This is a correctness finding record, not a release-readiness decision. Behavioral fixes and regression tests belong to the later implementation and regression-coverage TODOs unless explicitly called out below.

## References and method

The audit compared the implementation with the installed Pi 0.81.1 extension and SDK documentation, especially the custom-tool cancellation contract and the `AgentSession` `prompt()`, `abort()`, `subscribe()`, and `dispose()` lifecycle. The SDK documents `prompt()` as waiting for the complete accepted run and `abort()` as an asynchronous cancellation operation; callers still need a bounded local wait when a session implementation fails to settle its prompt after abort.

Reviewed implementation paths include:

- `src/coordinator.ts`, `todo_generator.ts`, `todo_parser.ts`, `result_writer.ts`, `task_progress.ts`, and `git.ts`;
- `src/session_guard.ts` and `worker_session.ts`;
- `src/goal_orchestrator.ts`, `goal_loop.ts`, `goal_state.ts`, `goal_todo_generation.ts`, `goal_todo_execution.ts`, and `goal_review.ts`;
- extension execution/cleanup in `src/index.ts`;
- the existing coordinator, worker, session-guard, TODO, goal-loop, goal-orchestrator, and reviewer tests.

The existing test suite and focused in-memory probes were used to exercise success, retry/failure, blocked, cancellation, malformed result, malformed TODO, interruption, and resume states without invoking paid model sessions.

## Lifecycle trace

### Direct long-task path

1. The coordinator creates the run directory and initializes `TASK_RESULT.md`.
2. Input is normalized locally when it resembles TODO markdown/a simple list; otherwise a guarded planner session creates and, once if needed, repairs the plan.
3. Valid TODO markdown is persisted. The first task whose parsed global progress state is not done is selected.
4. For each attempt, a worker session is created, subscribed, prompted, and expected to return a `TASK_RESULT` block. Worker events update in-memory progress/cost.
5. A worker `done` outcome currently causes the TODO checkbox/status block to be persisted before the attempt result is appended. Eligible changes may then be committed.
6. Non-done outcomes retry up to the configured limit. The final TODO is reparsed to derive completion and remaining-task counts.
7. The extension clears its sidebar in `finally`, including when orchestration throws.

Normal sequential execution is consistent: tasks run once in order, successful outcomes update both progress and status checkboxes, attempt records are appended, generated artifacts are excluded from commits, and final counts match the persisted TODO.

Expected worker-reported `partial`, `blocked`, and `failed` states do not update the TODO. At the retry limit they remain visible in `remainingTasks`. A default worker/session creation failure is converted into a partial worker result and retried. An exception escaping a custom/default worker boundary instead enters the coordinator-wide catch, which has the consistency defect recorded below.

Cancellation before or during planning is bounded by `runGuardedSessionPrompt`; it removes listeners/timers and disposes the planner session. Direct worker cancellation calls `session.abort()`, but unlike the planner guard it still awaits the original `prompt()` promise, so it is not locally bounded when abort does not settle that promise.

A direct run has no run-id resume API. Its practical resume path is feeding a persisted TODO artifact back through normalization. That path currently loses checked global progress and can duplicate completed work.

### Goal-loop path

1. A new versioned state is saved and result/trace files are initialized.
2. Optional discovery persists a goal specification.
3. Each iteration transitions `pending` → `todo_generated` → `todo_executed`/`failed` → reviewed; reviewer output then either starts another iteration or makes the loop terminal.
4. State/spec JSON writes are atomic; trace/result files are append-based.
5. Cancellation is checked at the top of the loop and at selected child boundaries.

Fresh normal, reviewer-incomplete, reviewer-complete, initially cancelled, max-iteration, and expected worker-failure paths are internally consistent in existing tests. Resume from `initialState`, cancellation during active child phases, and reviewer-session failures are not consistently handled; confirmed defects follow.

## Confirmed defects and priorities

Priority meanings: **P0** can falsely report completion; **P1** can hang, lose/duplicate work, corrupt the run record, or defeat a safety limit; **P2** is lower-impact reporting, cleanup, or malformed-input ambiguity.

### P0 — completion can be accepted without a trustworthy worker result

**Confirmed by probe and inspection.** `runWorkerTask()` sets `done` solely from the parsed status word. It does not require the rest of the required machine-readable block, and it does not disqualify an outcome carrying `error`, `aborted`, or `timedOut`.

Observed outcomes on the current code:

- `TASK_RESULT:\nstatus: done` after both the initial prompt and reminder produced `{ reportedStatus: "done", done: true, error: undefined }`.
- A complete `status: done` response followed by a rejected prompt produced `{ reportedStatus: "done", done: true, error: "transport failed after response" }`.

The coordinator trusts `outcome.done` and marks the TODO complete. Commit selection is more conservative and rejects an outcome with an error/timeout/abort, so persisted task completion and commit eligibility can disagree.

**Required fix:** define and validate the complete result shape (`status`, non-empty `summary`, and bullet-bearing `changes`, `verification`, and `remaining` fields); request the reminder for an incomplete block; and require a structurally complete result with no terminal session error/abort/timeout before setting `done`.

### P0 — reviewer session failure can mark the whole goal done

**Confirmed by probe and inspection.** `runGoalReviewSession()` parses `assistantText` without first rejecting `sessionResult.error`, `timedOut`, or `aborted`. A reviewer runner returning valid `decision: "complete"` JSON together with `{ timedOut: true, error: "review timeout" }` transitioned the goal state to `done`.

**Required fix:** treat timeout, abort, or reviewer-session error as a failed/cancelled review regardless of parseable stale/partial assistant text. Cancellation should persist `cancelled`; other failures should persist and return a structured failed result.

### P1 — worker and reviewer cancellation can wait forever after abort

**Confirmed by a bounded `Promise.race` probe.** A worker session whose `prompt()` never settles and whose `abort()` returns without settling it remained pending after outer cancellation. The planner does not have this defect because `runGuardedSessionPrompt()` resolves its own completion gate after abort.

The worker timeout path has an additional race: its timer awaits the graceful `steer()`/`prompt()` request before scheduling hard abort. If the graceful request hangs, hard abort is never scheduled. `runGoalReviewerSession()` similarly awaits the original prompt after its timeout callback calls abort.

**Required fix:** use the guarded prompt lifecycle (or an equivalent local completion gate) for worker/reviewer waits; schedule hard abort independently of graceful-message settlement; catch async abort/steer/dispose failures; and always unsubscribe, clear timers, and dispose once.

### P1 — checked TODO input is normalized back to incomplete

**Confirmed by probe.** Re-normalizing a valid two-task TODO with TODO 1 checked produced parsed states `[["1", false], ["2", false]]`. `normalizeExistingTodoMarkdown()` regenerates every progress line unchecked. `validateTodoMarkdown()` also only recognizes unchecked progress lines, preventing a checked artifact from being accepted unchanged.

This practical interruption/resume path reruns completed work. It can duplicate edits, verification, spend, and commits.

**Required fix:** preserve each task's parsed done state while renumbering/normalizing, accept checked or unchecked progress entries during validation, and select only genuinely incomplete tasks on resumed artifacts.

### P1 — empty `Status` can borrow checkboxes from later sections

**Confirmed by probe.** A task with an empty `**Status:**` followed by `**Verify:**\n- [ ] Run test` passed `validateTodoMarkdown()`. `findStatusItems()` does not stop at the next field heading before seeing its first checkbox, so the verification checkbox becomes a status item. `markTaskDone()` can then mark that verification item as status work.

**Required fix:** bound status parsing at the next section/field heading regardless of whether a checkbox has been seen, then reject an empty status block.

### P1 — escaped post-planning errors discard known task state in the returned result

**Confirmed by probe.** When `workerRunner` threw for a valid two-task plan, the coordinator returned `status: failed`, `totalTasks: 0`, and no remaining tasks. The persisted TODO still contained both tasks. The coordinator-wide catch always builds an empty task model even when planning had completed.

**Required fix:** retain the latest valid TODO/task snapshot and active-task failure in the catch path; append the failure to `TASK_RESULT.md`; return accurate total/completed/remaining counts and progress.

### P1 — completion persistence is ordered unsafely for interruption

**Confirmed by inspection.** On a done worker outcome, the coordinator writes the TODO as complete before appending the attempt result. A process/filesystem interruption between those writes leaves a completed task with no durable result evidence and causes resume to skip it.

**Required fix:** persist the attempt result first and make the TODO completion marker the final durable transition. A crash between those operations may conservatively retry, but must not silently skip unrecorded work.

### P1 — goal-loop resume is phase-incomplete and rewrites durable history

**Confirmed by probe and inspection.** Resuming an `initialState` whose current iteration is `todo_generated` failed with `Cannot start goal iteration from phase todo_generated.` The orchestrator always enters TODO generation instead of dispatching from the persisted phase. It also unconditionally rewrites `GOAL_RESULT.md` and appends the entire in-memory trace from index zero, duplicating/overwriting history on resume. `todo_executed`/`failed` states have the same phase-dispatch problem; only `pending` and a reviewed state happen to follow a viable next step.

**Required fix:** distinguish new versus resumed state; initialize artifacts only for a new run; append only trace entries not already durable; dispatch `pending` to generation, `todo_generated` to execution, `todo_executed`/`failed` to review, and `reviewed` to the next iteration. Verify each persisted boundary resumes without skipping or duplicating a phase.

### P1 — active goal-loop cancellation/failure is not returned consistently

**Confirmed by control-flow inspection.** Cancellation before the loop is structured. Cancellation during generation can throw `GoalTodoGenerationError` while leaving a pending state. Cancellation after child execution proceeds into review, where a pre-review abort persists cancellation but throws `GoalReviewError`. Mid-review abort is currently treated as reviewer parse/failure rather than cancellation. Discovery/generation/review exceptions can escape the tool, leaving only partial artifacts and no normal final details.

**Required fix:** centralize orchestration error/cancellation finalization, persist a terminal state/result exactly once, and return a structured terminal `GoalLoopRunResult` for expected abort/timeout paths.

### P1 — goal-loop deadlines are not enforced between every phase

**Confirmed by inspection.** Overall timeout is checked only at the loop boundary. Iteration time remaining constrains generated TODO execution, but an expired iteration still receives a minimum one-second worker budget and reviewer timeout remains the full configured duration. Discovery, generation, execution, and review can therefore continue after overall/iteration deadlines.

**Required fix:** check overall and iteration deadlines before and after each child phase; cap every child timeout, including review/discovery, to remaining overall/iteration time; persist the corresponding terminal reason.

### P1 — retry commit baseline can exclude the task's own earlier changes

**Confirmed by inspection.** `preExistingDirtyPaths` is captured per attempt. If an errored/failed/timed-out attempt leaves useful changes (and is correctly ineligible for commit), the next attempt treats those changes as pre-existing user work. A later done attempt therefore cannot commit the full task change.

**Required fix:** capture protected user-dirty paths once before the first attempt of a task and carry that baseline across retries, while continuing to exclude generated artifacts.

### P2 — abort arriving after the last successful worker produces contradictory completion

**Confirmed by probe.** If the signal is triggered as the sole worker returns done, the coordinator persisted 1/1 tasks complete but returned `status: partial` with `Pi Long Task run aborted.`

**Required fix:** after an attempt settles, reparse remaining tasks before assigning abort failure; if no work remains and the completed outcome is trustworthy, report done. Otherwise report abort with accurate remaining work.

### P2 — result-block selection can prefer stale fenced output

**Confirmed by inspection.** `extractTaskResultBlock()` searches all fenced blocks before the full text. An earlier fenced example containing `TASK_RESULT` can beat a later unfenced final block. This compounds the permissive completion validation.

**Required fix:** select the last valid block by source position, then validate its full structure.

### P2 — cleanup and cost-accounting errors are inconsistently contained

**Confirmed by inspection.** Worker/reviewer `dispose()` calls are not guarded; a thrown dispose can escape and replace the useful outcome. Reviewer session-stat reads are also not guarded. Reviewer event cost uses `Math.max`, which undercounts multiple assistant messages when session stats are unavailable. Resumed goal-loop cost totals are computed only from result arrays created in the current invocation, not persisted prior iterations.

**Required fix:** make cleanup best-effort with recorded diagnostics, sum/deduplicate message costs consistently, and derive resumed totals from persisted iteration state.

### P2 — validation does not structurally bind all plan elements

**Confirmed by inspection.** Progress-line matching is not limited to the `## Progress` block, and the required `---` can occur anywhere rather than specifically before task sections. Task-like headings inside fenced examples are also parsed as real tasks.

**Required fix:** parse explicit document regions and ignore fenced content; bind progress entries one-to-one with task sections and require the separator at the region boundary.

## State and persistence conclusions

- The direct happy path and expected retry-limit path agree with their persisted TODO/result files.
- Worker-reported failure does not normally mark a TODO complete, but malformed/error-bearing `done` does; this is release-blocking.
- Planner cancellation/timeout cleanup is bounded and diagnostic-rich.
- Worker/reviewer cancellation is not bounded independently from SDK prompt settlement.
- Direct TODO artifact resume currently duplicates completed tasks.
- Goal state writes are atomic, but orchestration cannot safely resume all persisted phases and can rewrite/duplicate result history.
- No source correction was made in this audit task so that behavior-changing fixes and their regression tests can be implemented together in the dedicated fix/coverage tasks. This document is the focused review artifact for the audit task.

## Verification record

- `npm test` — passed all 25 top-level test entries (0 failures, 0 skipped), including normal sequential completion, retry exhaustion, blocked results, planner timeout/abort/repair, initial goal cancellation, reviewer iterations, and session-guard cleanup.
- Focused in-memory audit probe via `node --experimental-strip-types --input-type=module` — confirmed checked progress resets, empty status acceptance, incomplete `done` acceptance, error-bearing `done` acceptance, escaped-worker task-count loss, contradictory 1/1 abort result, reviewer-error goal completion, and a worker cancellation that remained pending after abort.
- Focused goal-state resume probe via `node --experimental-strip-types --input-type=module` — confirmed `todo_generated` resume fails with `Cannot start goal iteration from phase todo_generated.`
- Paid/native model smoke was not run for this audit; the defects above reproduce deterministically without provider behavior. Native smoke remains part of final release validation after fixes.

## Fix order

1. Prevent false completion for worker and reviewer outcomes (both P0 findings).
2. Bound worker/reviewer timeout and cancellation waits.
3. Preserve direct TODO progress and implement phase-aware goal resume without rewriting history.
4. Correct malformed status parsing and coordinator catch-state reporting.
5. Reorder durable task completion and enforce goal deadlines/cancellation finalization.
6. Correct retry commit baselines, abort race, result selection, cleanup/cost accounting, and stricter document-region validation.

The plugin should not be considered release-ready until the P0/P1 findings are fixed with focused regression coverage and the full validation/native-smoke requirements pass.
