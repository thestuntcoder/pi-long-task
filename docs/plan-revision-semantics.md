# Plan revision semantics

This document defines how steering guidance may revise an active Pi Long Task plan. The shared reconciliation model is implemented in [`src/plan_revision.ts`](../src/plan_revision.ts).

## Current plan flow

Before steering support, plan state follows this path:

1. `runCoordinator` in `src/coordinator.ts` creates or normalizes planner output, calls `validateTodoMarkdown`, writes `TODO.md`, and parses it with `parseTasks`.
2. `parseTasks` in `src/todo_parser.ts` reads task sections and derives completion from the `## Progress` checkbox (preferred) or all `**Status:**` checkboxes.
3. The coordinator selects the first parsed task whose `done` value is false. Attempts and outcomes live in coordinator memory and are appended to `TASK_RESULT.md`.
4. A successful outcome is persisted by `markTaskDone` followed by an overwrite of `TODO.md`. The next scheduling pass reparses that markdown.
5. `buildTaskProgressModel` combines parsed tasks, attempts, and the current task ID. `src/render.ts` renders this model in partial tool output and the sidebar.
6. Final status is calculated by reparsing the persisted `TODO.md`; there is no separate persisted plan identity or revision number yet.

Consequently, checkbox state and attempt/output state must not be accepted from a revised planner response. They are coordinator-owned state that reconciliation transfers only when task identity and validity rules allow it.

## Identity and matching

A task may include an optional persistent marker directly below its heading:

```markdown
## TODO 2 — Build the API

<!-- pi-long-task-id: api-build -->
```

`parseTasks` exposes this marker as `Task.stableId`. IDs are limited to 1–128 letters, digits, `.`, `_`, `:`, or `-` (with an alphanumeric first character). They must be unique within each plan supplied to reconciliation.

Reconciliation uses this deterministic precedence:

1. **Stable ID:** equal explicit IDs match regardless of title, content, or position.
2. **Exact semantic content:** unmarked tasks match on normalized title and section content. TODO numbering, checkbox state, the identity marker, line endings, and formatting-only whitespace do not affect the fingerprint. Duplicate exact tasks pair in source order.
3. **Unique title:** remaining unmarked tasks match when the normalized title occurs exactly once among unmatched tasks on each side. This permits edits to a pending task body.
4. **No guess:** ambiguous or renamed unmarked tasks are remove+insert. It is safer to schedule work than to transfer completion to the wrong task.

Task numbers are display/order positions, not identities. Insertion that merely shifts numbers is not a reorder. A task is marked reordered only when its relative order against another matched task is inverted.

## Reconciliation rules

| Previous task          | Revised task                 | Result                                                                                                                       |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pending/failed/blocked | Equivalent                   | Keep prior state and identity.                                                                                               |
| Completed              | Equivalent                   | Keep completed, preserve outputs, and ignore an unchecked planner checkbox.                                                  |
| Running                | Equivalent or only reordered | Keep running; the current execution remains authoritative.                                                                   |
| Pending/failed/blocked | Modified match               | Accept revised content as pending; old attempts do not complete the changed requirement.                                     |
| Completed              | Modified match               | Retain old completed work and outputs as superseded history; add revised content as a pending follow-up with a new identity. |
| Running                | Modified match               | Retire the old execution as superseded, schedule revised content pending, and mark the old worker result stale.              |
| None                   | Inserted                     | Add pending. Planner-supplied completion is not trusted for new work.                                                        |
| Pending/failed/blocked | Removed                      | Remove from scheduling and retain a retired audit record.                                                                    |
| Completed              | Removed                      | Remove from active scheduling, but retain completed history and outputs.                                                     |
| Running                | Removed                      | Retire it and mark the in-flight result stale so it cannot update the accepted plan.                                         |

Matched unchanged tasks retain their state across insertion, removal, and reorder. Reconciliation returns active tasks in revised-plan order; generated follow-ups for explicitly invalidated removed work are appended. Every returned task receives its reconciled identity in `Task.stableId` and in its section marker so a renderer can persist that identity rather than positional numbering.

## Completed work and explicit invalidation

Completion is historical evidence and is never silently changed back to pending.

- If guidance does not affect completed requirements, the same identity remains completed and its outputs stay reusable.
- If revised content changes completed requirements, the prior identity is retained as completed history and a distinct pending follow-up is created.
- A caller may explicitly invalidate a previous task ID. Reconciliation still retains completed history, but always creates pending replacement/follow-up work even if proposed text is unchanged.
- Invalidating an unknown previous ID is an error; silently dropping invalidation would falsely claim the guidance was applied.
- Removing completed work from the new active plan does not delete its results or commit references.

`preserveOutputs` identifies records whose result/commit references remain valid. A follow-up starts with `preserveOutputs: false`; downstream context may still cite retained history, but it cannot use that history to claim the follow-up is complete.

## Running-task safety

The coordinator must associate every worker launch with the accepted plan revision and reconciled identity. `staleRunningTaskIds` means that the in-flight worker may finish for audit purposes, but its result must not mark any replacement complete. An unchanged or reordered running task is not stale and may continue.

Future persistence should atomically store the revised markdown, stable identities, coordinator states, and revision number before the scheduler selects more work. A status write from an older revision must fail its revision/identity check rather than overwrite the accepted plan.

## Invariants exposed to other components

`reconcilePlanRevision` enforces or represents these invariants:

- stable IDs and task IDs are unique within each input plan;
- planner checkbox state never manufactures completion for inserted or modified work;
- equivalent completed work remains completed and keeps outputs;
- changed completed work becomes follow-up work instead of erased history;
- ambiguous identity never receives transferred state;
- order is taken from the revised plan without interpreting index shifts as reorder;
- modified or removed running work produces a stale-result guard;
- explicit invalidation always results in schedulable work and cannot target an unknown task.

The returned `activeTasks`, `retiredTasks`, `matches`, and `staleRunningTaskIds` are intended to be consumed by steering message handling, TODO rendering/persistence, and coordinator scheduling without each component redefining these rules.
