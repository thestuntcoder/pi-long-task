# Pi Long Task

Pi Long Task is a Pi extension that breaks large coding requests into tracked TODOs, executes them in isolated worker sessions, shows progress in a sidebar, and optionally commits completed work.

Use it when a coding request is bigger than one focused interaction. Pi Long Task creates or cleans up the TODO plan, hands each TODO to a fresh worker session, tracks every attempt, and keeps the run artifacts so you can inspect what happened later.

## Why use it

- **Take on bigger tasks:** split broad product, refactor, testing, or cleanup requests into smaller TODOs that Pi can complete one at a time.
- **Track progress visibly:** see the active TODO, inferred `**Status:**` subtasks, completed/failed/blocked counts, and remaining work in Pi's long-task sidebar.
- **Recover with retries:** tasks that do not report completion can be retried with context from previous attempts instead of losing the thread.
- **Commit safely when asked:** enable commits for completed task work, while generated run files and pre-existing dirty files are kept out of those commits.
- **Keep task artifacts:** every run writes a generated `TODO.md`, generated `TASK_RESULT.md`, attempt summaries, and final status under `tmp/pi-long-task/<run-id>/`.
- **Watch cost visibility:** worker spend is captured and surfaced in progress and final summaries when usage cost data is available.

## What happens during a run

When you ask Pi to run a long task, Pi Long Task:

1. Recognizes natural-language requests like "run a long task with commits" and routes them to `pi_long_task`.
2. Creates or cleans up a TODO plan from your request.
3. Works through each unfinished TODO task in order using isolated worker sessions.
4. Shows the current task and inferred subtask progress in a sidebar while it runs.
5. Retries unfinished tasks up to the configured attempt limit.
6. Records progress, task artifacts, and final results under `tmp/pi-long-task/<run-id>/`.
7. Returns a summary with completed, failed, blocked, and remaining task counts, plus worker spend when available.
8. Optionally commits completed work after each task.

A finished run gives you:

- a concise status summary in Pi
- a generated `TODO.md`
- a generated `TASK_RESULT.md`
- live sidebar progress for the active task and its `**Status:**` checkbox subtasks
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

Run without commits when you want to review all changes yourself before committing:

```text
Run a long task without commits to add tests for the parser and fix any failures.
```

```text
Run a long task without commits to audit the README examples and leave the final diff uncommitted.
```

## What it looks like

Pi keeps the active worker transcript in the main content area and shows the run timeline in the sidebar:

```text
┌─ Main content: active worker activity ───────────────┬─ Pi Long Task sidebar ───────────────┐
│ Worker TODO 2 — Add parser tests                    │ Progress: 2/5 tasks complete (40%)   │
│                                                      │ Worker spend: $0.18                  │
│ $ npm test -- parser                                │                                      │
│ ✓ parser handles nested arrays                      │ Timeline                             │
│ ✗ parser rejects invalid escapes                    │ ● TODO 1 Rewrite intro        done   │
│                                                      │ ● TODO 2 Add parser tests     active │
│ Editing src/parser.test.ts...                       │   ◌ add edge-case fixtures           │
│ Re-running focused tests after fix...               │   ◌ fix failing assertions           │
│                                                      │ ○ TODO 3 Update docs          next   │
│                                                      │ ○ TODO 4 Validate install     later  │
│                                                      │                                      │
│ The worker reports commands, file edits, and result  │ Sidebar tracks task statuses,        │
│ details here while the current TODO is running.      │ subtask progress, timeline, spend.   │
└──────────────────────────────────────────────────────┴──────────────────────────────────────┘
```

## How it works

Pi Long Task coordinates a long request from planning through task completion:

1. **Plan the work:** it creates a TODO plan from your request, or normalizes pasted TODO markdown so each item can be tracked consistently.
2. **Run isolated workers:** each TODO is assigned to its own fresh worker session with the relevant task text, global instructions, attempt history, and commit setting.
3. **Stream progress back:** the active worker's activity streams into the main Pi thread, so you can follow commands, edits, verification, and the final `TASK_RESULT` as they happen.
4. **Show every task in the sidebar:** the sidebar lists the full run timeline, including completed, active, upcoming, failed, or blocked tasks and inferred subtask progress from each task's `**Status:**` checklist.
5. **Write run artifacts:** the coordinator writes the generated/normalized `TODO.md`, `TASK_RESULT.md`, attempt summaries, and final run details to `tmp/pi-long-task/<run-id>/`.
6. **Commit only when enabled:** if `commit` is `true`, Pi Long Task may create a commit after each completed task using only eligible task changes. If commits are disabled, no commits are created; even when enabled, commits can be skipped when there are no eligible changes or the task outcome is not commit-worthy.

## Feature reference

- **Sidebar task timeline:** every TODO appears in the sidebar with past, current, and future statuses so you can distinguish completed, active, upcoming, failed, blocked, and remaining work at a glance.
- **Main-thread worker activity:** the active worker streams commands, edits, verification, and its per-task `TASK_RESULT` back into the main Pi conversation.
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

Use a pasted TODO plan:

```text
Use pi_long_task with inputText "<paste TODO markdown here>" and commit false.
```

## Options

The tool has two inputs:

```ts
{
  inputText: string;
  commit: boolean;
}
```

- `inputText` is the request or TODO markdown to work on.
- `commit` controls whether Pi Long Task may create git commits.

For natural-language requests, Pi Long Task routes phrases like "run a long task with commits" to the tool with commits enabled. If you ask for a long task without mentioning commits, commits stay disabled.

Natural-language routing intentionally avoids informational questions, such as "How do I run a long task with commits?", and explicit tool calls are left unchanged.

No other public options are required.

## Progress display

While a task is running, Pi Long Task shows the active TODO and subtasks parsed from that task's `**Status:**` checkbox list.

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
- Real runs require usable Pi model credentials, such as a working Pi login or API key for the selected model.
- Worker spend is added to the main Pi `$ spent` total as cost-only usage. Token counts are not merged into the main thread because worker sessions have separate context windows, and merging their token usage would corrupt the main conversation's context statistics.
- Run artifacts are written under `tmp/pi-long-task/<run-id>/`.

## License

MIT. See [LICENSE](LICENSE).
