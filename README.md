# Pi Long Task

Pi Long Task is a Pi extension that breaks large coding requests into tracked TODOs, executes them in isolated worker sessions, registers a real Pi TUI progress sidebar while a run is active, and optionally commits completed work.

Use it when a coding request is bigger than one focused interaction. Pi Long Task creates or cleans up the TODO plan, hands each TODO to a fresh worker session, tracks every attempt, and keeps the run artifacts so you can inspect what happened later.

## Why use it

- **Take on bigger tasks:** split broad product, refactor, testing, or cleanup requests into smaller TODOs that Pi can complete one at a time.
- **Track progress visibly:** in Pi TUI, see the active TODO, inferred `**Status:**` subtasks, completed/failed/blocked counts, and remaining work in the Pi Long Task sidebar while the run is active.
- **Recover with retries:** tasks that do not report completion can be retried with context from previous attempts instead of losing the thread.
- **Commit safely when asked:** enable commits for completed task work, while generated run files and pre-existing dirty files are kept out of those commits.
- **Keep task artifacts:** every run writes a generated `TODO.md`, generated `TASK_RESULT.md`, attempt summaries, and final status under `tmp/pi-long-task/<run-id>/`.
- **Watch cost visibility:** worker spend is captured and surfaced in progress and final summaries when usage cost data is available.

## What happens during a run

When you ask Pi to run a long task, Pi Long Task:

1. Recognizes natural-language requests like "run a long task with commits" and routes them to `pi_long_task`.
2. Creates or cleans up a TODO plan from your request, optionally guided by a high-level `goal`. Natural-language planning uses a bounded planner session; if generated TODO markdown is invalid, Pi Long Task asks the planner to repair it once before failing the run.
3. Works through each unfinished TODO task in order using isolated worker sessions.
4. Registers a Pi TUI sidebar/widget when UI support is available and updates it with the current task, inferred subtask progress, and full task timeline while the run is active.
5. Retries unfinished tasks up to the configured attempt limit.
6. Records progress, planner diagnostics, task artifacts, and final results under `tmp/pi-long-task/<run-id>/`.
7. Returns a summary with completed, failed, blocked, and remaining task counts, plus worker spend when available.
8. Optionally commits completed work after each task.

For a large project goal, this means Pi Long Task turns the single broad request into structured TODO tasks first, then assigns each TODO to a worker session one at a time. For example, a hypothetical request to build a fast team chat app would become a plan of focused tasks instead of one giant all-at-once implementation; workers would complete or report on each task incrementally before the coordinator moves to the next task.

During and after a run you get:

- a concise status summary in Pi
- a generated `TODO.md`
- a generated `TASK_RESULT.md`
- live TUI sidebar progress during the run for the active task and its `**Status:**` checkbox subtasks
- task attempt history and any remaining or blocked tasks clearly listed
- worker spend when cost data is available
- commit hashes when commits were enabled and created

## Install

Install it from npm with:

```bash
pi install npm:pi-long-task
```

For local development, load this checkout for one Pi session:

```bash
pi -e /path/to/pi-long-task
```

Or install the local checkout so Pi can load it normally:

```bash
pi install /path/to/pi-long-task
```

After installing, start `pi` in your target project and ask it to run a long task.

To update an existing npm install:

```bash
pi update npm:pi-long-task
```

Or update all installed Pi extension packages:

```bash
pi update --extensions
```

## Quick start examples

Use natural language; you do not need to mention `pi_long_task` explicitly. Copy one of these prompts and replace the quoted work with your own task.

Run with commits enabled, so each completed TODO can be committed separately:

```text
Run a long task with commits to implement the TODOs in @TODO.md.
```

```text
Run a long task with commits to refactor the checkout flow, update the tests, and commit each completed task.
```

Request commits and a coverage target in the same natural-language prompt:

```text
Run a long task with commits with goal to have testing line coverage above 80%.
```

Run without commits when you want to review all changes yourself before committing:

```text
Run a long task without commits to add tests for the parser and fix any failures.
```

```text
Run a long task without commits to audit the README examples and leave the final diff uncommitted.
```

### What "with commits" means

When you ask for a long task "with commits," Pi Long Task may create a git commit after each TODO task that a worker completes with eligible changes. Each worker session is expected to stay focused on its assigned TODO only, so any commit reflects a specific slice of progress rather than the entire broad request.

Those incremental commits preserve completed work between worker sessions, make it easier to review what changed for each task, and provide clear checkpoints if a later task is blocked or needs another attempt.

### Scope expectations for broad product goals

A hypothetical request like "run a long task with commits to build a fast Slack alternative" is too large and vague to finish as one instant product build. Pi Long Task would first turn that broad goal into a realistic plan, often centered on an MVP rather than every feature of a full Slack replacement.

The generated plan would break the work into focused areas such as authentication, workspace/channel data, message creation and history, realtime sync, persistence, UI screens, tests, and deployment or configuration follow-up. Each area would become one or more TODO tasks assigned to separate worker sessions, with incremental verification and optional commits along the way.

The initial result should be expected to be a structured TODO plan, MVP-oriented breakdown, or first narrow implementation slice. A complete production-ready team chat product would require many focused tasks and repeated progress checks, not a single vague prompt completing everything immediately.

## How to run a Long Task

### 1. Prepare the work request

Pi Long Task can plan from a plain-language request or from pasted TODO markdown. If you write the TODO markdown yourself, use this structure:

```markdown
# Pi Long Task TODO

Global instructions:

- Keep any rule that applies to every task here.

## Progress

- [ ] TODO 1 — First focused task
- [ ] TODO 2 — Second focused task

---

## TODO 1 — First focused task

**Goal:** Explain the outcome for this task.

**Status:**

- [ ] Implement the first focused task

**Verify:**

- Run the focused check for this task.

**Done when:**

- The task is implemented and verified.

## TODO 2 — Second focused task

**Goal:** Explain the outcome for this task.

**Status:**

- [ ] Implement the second focused task

**Verify:**

- Run the focused check for this task.

**Done when:**

- The task is implemented and verified.
```

### 2. Start Pi in the target project

Install or load the extension first, then run Pi from the repository you want to modify:

```bash
cd /path/to/your/project
pi
```

In the Pi prompt, use natural language:

```text
Run a long task without commits to implement the TODOs in @TODO.md.
```

Or call the tool explicitly:

```text
Use pi_long_task with inputText "implement the TODOs in @TODO.md" and commit false.
```

Use `with commits` or `commit true` only when you want Pi Long Task to create eligible commits after completed tasks.

### 3. Monitor progress and completion

During execution, Pi Long Task creates `tmp/pi-long-task/<run-id>/TODO.md` and `TASK_RESULT.md`, runs one isolated worker session per unfinished TODO in order, and retries unfinished tasks up to the configured attempt limit. In Pi TUI, watch the Long Task sidebar/widget for the active task, subtask checklist, task timeline, counts, and worker spend when available. In headless or non-UI runs, watch the partial tool-result updates in the main output. When the run finishes, the final response lists completed, failed, blocked, and remaining task counts plus the result and TODO file paths.

## What it looks like

In Pi TUI, Pi Long Task keeps worker activity in the main tool result flow and registers a real right-side TUI sidebar for the run timeline:

```text
┌─ Main content: active worker activity ─────────┬─ Pi Long Task sidebar ─────────┐
│ Worker TODO 2 — Add parser tests               │ Progress: 2/5 tasks complete   │
│                                                │ Worker spend: $0.18            │
│ $ npm test -- parser                           │                                │
│ ✓ parser handles nested arrays                 │ Timeline                       │
│ ✗ parser rejects invalid escapes               │ ✓ TODO 1 Rewrite intro done    │
│                                                │ ▶ TODO 2 Add tests active      │
│ Editing src/parser.test.ts...                  │   ◌ add edge fixtures          │
│ Re-running tests after fix...                  │   ◌ fix assertions             │
│                                                │ ○ TODO 3 Update docs next      │
│ Worker reports commands, edits, results here.  │ ○ TODO 4 Validate later        │
│ Current TODO output stays in main thread.      │ Tracks status/timeline/spend   │
└────────────────────────────────────────────────┴────────────────────────────────┘
```

The actual sidebar is a Pi TUI overlay anchored on the right when the terminal is large enough, with a Pi widget fallback for UI contexts where the overlay is unavailable. It is cleared when the run finishes; this README mockup stays narrow enough to avoid wrapping in package galleries.

## How it works

Pi Long Task coordinates a long request from planning through task completion:

1. **Plan the work:** it creates a TODO plan from your request, or normalizes pasted TODO markdown so each item can be tracked consistently.
2. **Run isolated workers:** each TODO is assigned to its own fresh worker session with the relevant task text, global instructions, attempt history, and commit setting.
3. **Stream progress back:** the active worker's activity streams into the main Pi thread as partial tool results, so you can follow commands, edits, verification, and the final `TASK_RESULT` as they happen.
4. **Update the Pi TUI sidebar:** when Pi provides UI support, the extension uses Pi's TUI UI APIs to maintain a real sidebar/widget that lists the full run timeline, including completed, active, upcoming, failed, or blocked tasks and inferred subtask progress from each task's `**Status:**` checklist.
5. **Write run artifacts:** the coordinator writes the generated/normalized `TODO.md`, `TASK_RESULT.md`, attempt summaries, and final run details to `tmp/pi-long-task/<run-id>/`.
6. **Commit only when enabled:** if `commit` is `true`, Pi Long Task may create a commit after each completed task using only eligible task changes. If commits are disabled, no commits are created; even when enabled, commits can be skipped when there are no eligible changes or the task outcome is not commit-worthy.

## Feature reference

- **Real Pi TUI sidebar:** in TUI sessions, every TODO appears in a registered sidebar/widget with past, current, and future statuses so you can distinguish completed, active, upcoming, failed, blocked, and remaining work at a glance.
- **Main-thread worker activity:** the active worker still streams commands, edits, verification, and its per-task `TASK_RESULT` back into the main Pi conversation; the sidebar does not replace tool-result rendering.
- **Cost visibility:** worker spend is included in Pi Long Task progress and is added to the main Pi `$ spent` total when cost data is available.
- **Result and TODO artifacts:** each run keeps the generated or normalized `TODO.md`, aggregate `TASK_RESULT.md`, per-attempt summaries, and final run details under `tmp/pi-long-task/<run-id>/`.
- **Commit-safe behavior:** when commits are enabled, Pi Long Task commits only eligible completed-task changes and skips generated run files.
- **Dirty-worktree protection:** files that were dirty before a worker started are not included in Pi Long Task commits, keeping your existing local work separate.

## Usage

You can also call the tool explicitly.

Run without commits:

```text
Use pi_long_task with inputText "add tests for the parser and fix any failures" and commit false.
```

Run with commits:

```text
Use pi_long_task with inputText "implement the TODOs in @TODO.md" and commit true.
```

Run with an explicit high-level goal for the planner and worker prompts:

```text
Use pi_long_task with inputText "update the checkout TODOs" and commit false and goal "ship a reliable checkout recovery experience".
```

When a goal is enough context, `inputText` can be omitted:

```text
Use pi_long_task with commit true and goal "have testing line coverage above 80%".
```

Use a pasted TODO plan:

```text
Use pi_long_task with inputText "<paste TODO markdown here>" and commit false.
```

## Goal-oriented iterative loop

Use `pi_goal_task` when you have a high-level outcome instead of a ready TODO plan and want Pi Long Task to keep iterating until a reviewer confirms the goal is complete.

```text
Use pi_goal_task with goal "modernize the settings page, add tests, and update docs" and commit true.
```

### Discovery for vague software goals

When a `pi_goal_task` goal is vague, such as a short product direction or broad feature idea, the goal loop first runs software-focused discovery before implementation TODOs are generated. Discovery turns the original goal into a persisted product definition and definition-of-done so implementation workers do not have to guess the scope.

Discovery uses role-based planning outputs from these supported roles:

- Product Owner
- Project Manager
- Software Architect/Tech Lead
- UX/UI Designer
- QA/Reviewer
- Marketing/Growth, when relevant for user-facing launch or adoption context

The consolidated specification is saved as `GOAL_SPEC.json` under the goal run directory. It includes traceability to the original user goal, role-output summaries, in-scope and out-of-scope requirements, assumptions, open questions, milestones, acceptance criteria, verification gates, design constraints, product constraints, optional marketing/growth context, and a definition-of-done with required artifacts and notes.

For vague goals, the loop runs as:

1. accept the high-level `goal`
2. classify the goal as vague and run discovery
3. persist `GOAL_SPEC.json`
4. generate implementation TODO markdown from the persisted specification
5. run that generated TODO as a normal long task in an isolated worker session
6. run a separate reviewer session that decides `complete`, `incomplete`, `blocked`, or `failed` against the persisted specification
7. if the reviewer says `incomplete`, generate another TODO using previous review context plus the same persisted specification and repeat

Implementation TODO generation treats the persisted specification as the source of truth. Generated tasks are instructed to cover relevant requirement, milestone, acceptance-criterion, verification-gate, constraint, and definition-of-done items, including spec IDs such as `REQ-*`, `MS-*`, `AC-*`, and `VG-*` where applicable. Reviewer sessions also load the persisted specification and use it as the primary review target; the original goal remains available for traceability, but vague wording alone is not the completion standard.

### Concrete goals and compatibility

When a `pi_goal_task` goal is already concrete, existing direct behavior is preserved: the loop skips discovery and generates implementation TODOs from the provided goal, previous iteration context, and reviewer feedback. Goals are generally considered concrete when they already include implementation details such as files or paths, specific commands/tests, explicit acceptance criteria, or enough detailed scope for direct TODO generation.

`pi_long_task` behavior is unchanged. Discovery is only enabled by default for `pi_goal_task`; direct long-task planning, TODO normalization, worker execution, progress display, retries, artifacts, and commit behavior continue to work as before.

Goal-loop artifacts are stored under `tmp/pi-goal-task/<goal-run-id>/`, including `GOAL_STATE.json`, `GOAL_TRACE.jsonl`, `GOAL_RESULT.md`, optional `GOAL_SPEC.json` for discovered goals, and per-iteration generated TODO, worker, and reviewer files. Child TODO execution still writes normal `tmp/pi-long-task/<run-id>/` artifacts.

Safety controls:

- `maxIterations` stops retry loops when the reviewer keeps finding remaining work.
- `timeoutMs` caps the overall goal loop.
- `iterationTimeoutMs` caps each generated TODO worker iteration.
- `reviewerTimeoutMs` caps each reviewer session.
- tool cancellation is passed through and stops the loop with `cancelled` status.
- `maxAttemptsPerTask` and `maxBashTimeoutMs` are forwarded to worker long-task runs.
- `commit` controls whether implementation workers may commit; goal loops default to `commit true`, so pass `commit false` when you want to review all changes first.

## Options

`pi_long_task` has one required input and two optional inputs:

```ts
{
  commit: boolean;
  inputText?: string;
  goal?: string;
}
```

- `commit` controls whether Pi Long Task may create git commits.
- `inputText` optionally provides the request or TODO markdown to work on.
- `goal` optionally provides a high-level desired outcome that is passed to TODO planning and worker task prompts. Coverage goals such as `have testing line coverage above 80%` add coverage-specific planning and verification guidance.

`pi_goal_task` accepts a high-level goal plus safety controls:

```ts
{
  goal: string;
  commit?: boolean;
  maxIterations?: number;
  timeoutMs?: number;
  iterationTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  maxAttemptsPerTask?: number;
  maxBashTimeoutMs?: number;
}
```

Use `pi_goal_task` for iterative goal completion. Vague `pi_goal_task` goals enter discovery and persist `GOAL_SPEC.json`; already concrete goals keep the direct implementation path. Use `pi_long_task` when you already have a concrete request or TODO markdown and want one planned long-task run.

For natural-language requests, Pi Long Task routes phrases like "run a long task with commits" to the tool with commits enabled. Phrases like "with goal to have testing line coverage above 80%" are parsed into the `goal` option. If you ask for a long task without mentioning commits, commits stay disabled.

Natural-language routing intentionally avoids informational questions, such as "How do I run a long task with commits?", and explicit tool calls are left unchanged.

No other public options are required.

## Progress display

While a task is running, Pi Long Task shows the active TODO and subtasks parsed from that task's `**Status:**` checkbox list. In Pi TUI this appears in the live sidebar/widget; in headless or non-UI contexts the same progress is still published through partial tool results.

Status markers are:

- `○` not started
- green `●` done
- orange `●` inferred as in progress

Because workers currently report structured results at the end of a task, in-progress subtask state is inferred: the first unchecked status item is shown as in progress while the task runs.

## Commits and files

When `commit` is `false`, Pi Long Task never creates commits.

When `commit` is `true`, it may commit eligible task changes after a task reports useful progress. It avoids committing:

- generated run files under `tmp/pi-long-task/`
- generated `TASK_RESULT.md` files
- files that were already dirty before the task started

This lets you keep existing local work separate from Pi Long Task changes.

Commit messages are generated from the task title and adjusted to resemble recent commit-message style in the repository. Pi Long Task does not prefix commits with generated labels like `Complete TODO 1 — ...`.

## Development and validation

Run the local development checks:

```bash
cd /path/to/pi-long-task
npm run check
```

Check that Pi can load the extension:

```bash
PI_OFFLINE=1 pi --mode json --no-extensions -e /path/to/pi-long-task --no-session
```

Run the full native smoke test if Pi has usable model credentials:

```bash
npm run smoke:native
```

That smoke test creates disposable git repos and verifies both `commit: false` and `commit: true` runs.

## Limitations and expectations

- Tasks run sequentially, one TODO at a time; Pi Long Task prioritizes isolation, progress tracking, and safe handoff over parallel execution.
- Natural-language TODO planning has a bounded time budget (five minutes by default, with a short graceful-shutdown request). If planning times out or is aborted before a valid plan exists, the run fails before worker tasks start and records planner diagnostics in `TASK_RESULT.md`.
- If the planner returns invalid TODO markdown, Pi Long Task makes one repair attempt. A second invalid response fails planning with diagnostics instead of guessing at a plan.
- Real runs require usable Pi model credentials, such as a working Pi login or API key for the selected model.
- Worker spend is added to the main Pi `$ spent` total as cost-only usage. Token counts are not merged into the main thread because worker sessions have separate context windows, and merging their token usage would corrupt the main conversation's context statistics.
- Run artifacts are written under `tmp/pi-long-task/<run-id>/`.

## License

MIT. See [LICENSE](LICENSE).
