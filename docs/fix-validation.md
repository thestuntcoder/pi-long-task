# Pi Long Task fix and validation record

Fix review date: 2026-07-22. This record covers TODO 5 implementation work for the confirmed findings in [`plugin-correctness-audit.md`](plugin-correctness-audit.md). It is not the final release-readiness decision.

## Priority and implemented fixes

The two false-completion findings were treated as P0. Hangs, duplicated/lost work, unsafe durability ordering, incomplete resume behavior, deadline/cancellation inconsistencies, and retry commit safety were treated as release-blocking P1.

### Trustworthy direct-task completion

- A worker result is complete only when the last `TASK_RESULT` in source order has a recognized status, a non-empty summary, and bullet-bearing `changes`, `verification`, and `remaining` fields.
- A parseable `done` result is not trusted when the session also errors, times out, or is aborted.
- An incomplete result gets one reminder. Checked TODO progress survives normalization so a persisted TODO can skip completed tasks.
- Status parsing stops at the next field heading. An empty `**Status:**` cannot borrow a checkbox from `**Verify:**`.
- Attempt evidence is appended before the TODO completion marker. Escaped worker errors retain the valid plan, task counts, remaining work, and active-task evidence.
- Cancellation arriving with the final trustworthy completion reports success; cancellation with remaining work remains partial.

### Bounded sessions and cleanup

- Worker cancellation resolves a local completion gate without relying on Pi's prompt promise to settle after `abort()`.
- Worker hard abort is scheduled independently of the graceful result request, so a hanging `steer()`/`followUp()` cannot suppress it.
- Reviewer prompts use the shared guarded-session lifecycle and are likewise bounded on timeout/cancellation.
- Worker/reviewer stats and disposal are best-effort. Cleanup failures no longer replace a useful outcome. Message-level reviewer costs are summed and deduplicated when session totals are unavailable.

These changes follow the installed Pi 0.81.1 SDK contract: `prompt()` waits for the complete accepted run, `abort()` is asynchronous, subscriptions are session-specific, and callers own disposal. The local gate is an extension-side safety boundary rather than an assumption that Pi must settle a misbehaving injected/session implementation.

### Persistence, retries, and goal-loop resume

- The protected dirty-path set is captured before a task's first attempt and retained across retries, allowing a later successful attempt to commit the task's earlier eligible changes without including pre-existing user work.
- Goal orchestration dispatches from persisted `pending`, `todo_generated`, `todo_executed`/`failed`, and reviewed phases. Existing result files are initialized only when missing, and only trace events not already durable are appended.
- Reviewer session error/timeout cannot be overridden by stale parseable completion text. Review abort persists cancellation.
- Expected generation, execution, and review cancellation/failure paths return structured terminal goal results rather than escaping the orchestrator.
- Overall and iteration deadlines are checked between child phases. Generation/execution/review budgets are capped to the remaining applicable deadlines; an expired iteration does not receive an extra one-second work budget.
- Resumed progress cost totals are derived from persisted iteration state, including TODO-generation worker cost.

## Regression coverage added with fixes

Focused tests now cover:

- incomplete and error-bearing worker `done` results;
- last-result selection after an earlier fenced example;
- worker/reviewer prompts that never settle after cancellation and a graceful worker request that hangs before hard abort;
- checked-TODO normalization, empty status blocks, and misplaced progress entries;
- escaped-worker counts/evidence, attempt-before-completion durability, final-completion abort, and cross-retry commit baselines;
- reviewer timeout plus parseable completion;
- resume from `todo_generated`, `todo_executed`, and reviewed boundaries without artifact rewrite/trace duplication;
- active goal cancellation and expired iteration deadlines returning structured states.

## Lower-priority limitations

The following non-release-blocking P2 limitations remain documented for later hardening:

1. Required task field labels and status checkboxes are not fully lexed out of fenced prose inside an otherwise real task section. Task headings and global progress entries inside fences are ignored, progress is region-bound, and empty status is rejected, so the known work-loss/false-completion cases are fixed; a stricter full Markdown lexer can be added separately.
2. Reviewer cleanup failure is intentionally swallowed to preserve the useful review outcome but is not currently exposed as a dedicated reviewer diagnostic field. Worker cleanup diagnostics are retained in compaction/session observations.
3. A custom injected discovery runner has no timeout parameter. Built-in discovery is local and bounded by phase checks before and after it; SDK callers supplying a custom runner remain responsible for honoring the abort signal.
4. Credentialed native model smoke, package dry-run inspection, and the final clean-tree release recommendation belong to TODO 6.

## Verification record

The focused and complete commands, exact results, and any environment limitations are recorded in the TODO 5 task result. No build command exists: Pi loads the TypeScript entry point directly, and `npm run typecheck` is the declared no-emit build-equivalent check.
