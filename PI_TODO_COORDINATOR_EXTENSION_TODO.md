# Pi Coordinator TODO — Native Pi TODO Coordinator Extension

Goal: Build a standalone/native Pi extension package that replaces `scripts/pi_todo_coordinator.py` without wrapping or spawning that Python script. The resulting extension must expose only one public tool input shape: `{ inputText: string, commit: boolean }`.

Global constraints for every task:
- Do not run `git commit`; the outer coordinator handles commits if enabled.
- Do not edit `TASK_RESULT.md`; the outer coordinator writes it.
- Do not depend on `scripts/pi_todo_coordinator.py` from the new extension implementation.
- Do not spawn `pi --mode rpc` from the new extension implementation.
- Worker sessions must not recursively load the coordinator extension.
- Keep the public tool schema limited to exactly `inputText` and `commit`.
- Prefer TypeScript and Pi SDK APIs from `@earendil-works/pi-coding-agent`.
- Put all extension package code in `~/Sites/pi-coordinator` (`/Users/dj/Sites/pi-coordinator`).
- Keep generated coordinator artifacts under a run directory such as `tmp/pi-coordinator/<run-id>/`.
- Never commit coordinator artifacts or files that were already dirty before a worker task started.
- Add or update tests where practical.

## Progress

- [ ] TODO 1 — Create standalone Pi package skeleton
- [ ] TODO 2 — Port TODO markdown parsing and progress mutation
- [ ] TODO 3 — Port TODO generation from raw input
- [ ] TODO 4 — Port worker prompt and TASK_RESULT parsing
- [ ] TODO 5 — Implement native Pi SDK worker session runner
- [ ] TODO 6 — Implement coordinator orchestration loop
- [ ] TODO 7 — Implement git commit safety and artifact exclusion
- [ ] TODO 8 — Add tool streaming updates and structured result details
- [ ] TODO 9 — Add automated tests for pure coordinator logic
- [ ] TODO 10 — Add documentation and smoke-test instructions

---

## TODO 1 — Create standalone Pi package skeleton

**Goal:** Create a standalone Pi extension package directory for the native coordinator.

**Status:**
- [ ] Create package structure
- [ ] Add Pi package manifest
- [ ] Register stub extension tool
- [ ] Verify package loads in Pi

**Implementation details:**
Create the package directory at `~/Sites/pi-coordinator` (`/Users/dj/Sites/pi-coordinator`):

```text
~/Sites/pi-coordinator/
  package.json
  src/
    index.ts
    types.ts
    coordinator.ts
    todo_parser.ts
    todo_generator.ts
    worker_session.ts
    result_writer.ts
    git.ts
    render.ts
  test/
```

`package.json` should use the package name `pi-coordinator` and declare a Pi package with a `pi.extensions` entry pointing at `src/index.ts`.

Use peer dependencies for Pi-provided packages:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

`src/index.ts` must register a stub custom tool named `pi_todo_coordinator` with exactly these parameters:

```ts
{
  inputText: string,
  commit: boolean
}
```

The stub can return a placeholder response until later TODOs wire in real behavior.

**Verify:**
- Run a command that loads the extension without executing real model work, for example `pi --offline --no-extensions -e ~/Sites/pi-coordinator --list-models`.
- Confirm no TypeScript/runtime loading errors are reported.

**Done when:** The package loads as a Pi extension and exposes a stub `pi_todo_coordinator` tool with only `inputText` and `commit`.

---

## TODO 2 — Port TODO markdown parsing and progress mutation

**Goal:** Port the pure TODO parsing/progress logic from the Python coordinator into TypeScript.

**Status:**
- [ ] Define task-related types
- [ ] Parse task headings
- [ ] Parse progress checklist status
- [ ] Parse per-task status checkboxes
- [ ] Mark tasks done in markdown content

**Implementation details:**
Implement `src/todo_parser.ts` with functions equivalent to the Python coordinator's pure parsing helpers:

- parse task headings like `## TODO 1 — Task title`
- parse progress lines like `- [ ] TODO 1 — Task title`
- parse optional `**Status:**` checkbox blocks
- return incomplete tasks
- mark a task done by updating both progress and status checkboxes
- extract global TODO instructions before `## Progress` or the first task heading

Suggested exports:

```ts
export interface Task {
  taskId: string;
  title: string;
  section: string;
  startLine: number;
  endLine: number;
  done: boolean;
  progressDone?: boolean;
  statusCheckboxes: boolean[];
}

export function parseTasks(markdown: string): Task[];
export function incompleteTasks(markdown: string): Task[];
export function markTaskDone(markdown: string, taskId: string): string;
export function todoGlobalInstructions(markdown: string, limit?: number): string;
```

Keep regex compatibility with the current Python script, including both em dash and hyphen separators.

**Verify:**
- Add focused tests or a small local script for parsing an example TODO markdown file.
- Confirm marked-done output preserves the rest of the file content.

**Done when:** TypeScript parser behavior matches the Python coordinator for task detection, completion detection, and done marking.

---

## TODO 3 — Port TODO generation from raw input

**Goal:** Convert raw `inputText` into coordinator-compatible TODO markdown.

**Status:**
- [ ] Detect existing coordinator TODO markdown
- [ ] Convert simple bullet/numbered lists locally
- [ ] Add TODO planner prompt builder for complex raw input
- [ ] Validate generated TODO markdown

**Implementation details:**
Implement `src/todo_generator.ts`.

Behavior:
1. If input already contains task headings like `## TODO N — Title`, normalize it and add a progress checklist if missing.
2. If input is a simple bullet/numbered list with multiple items, generate TODO markdown locally without model work.
3. For complex raw input, provide a TODO planner flow that can use a native Pi SDK session in a later TODO or can be called by the coordinator once worker sessions exist.

Suggested exports:

```ts
export function todoMarkdownFromString(rawInput: string): string | undefined;
export function generatedTodoMarkdown(items: string[]): string;
export function validateTodoMarkdown(markdown: string): void;
export function buildTodoCreationPrompt(rawInput: string): string;
export function extractTodoMarkdown(assistantText: string): string;
```

The generated markdown must include:

- `# Pi Coordinator TODO`
- `## Progress`
- unchecked progress lines
- `---`
- one `## TODO N — Title` section per task
- `**Goal:**`
- `**Status:**` checkboxes
- `**Verify:**` or concrete verification guidance
- `**Done when:**`

**Verify:**
- Add tests for existing TODO input, bullet list input, numbered list input, and complex single-paragraph input prompt construction.

**Done when:** Raw text can be converted or prepared for conversion into valid coordinator-compatible TODO markdown.

---

## TODO 4 — Port worker prompt and TASK_RESULT parsing

**Goal:** Port prompt construction and worker result parsing into TypeScript.

**Status:**
- [ ] Build assigned-task worker prompt
- [ ] Build timeout/shutdown steering messages
- [ ] Extract assistant text from Pi messages/events
- [ ] Parse `TASK_RESULT` status
- [ ] Summarize/truncate assistant result text

**Implementation details:**
Create or update `src/worker_session.ts` and `src/result_writer.ts` with pure helpers before wiring real SDK sessions.

Port behavior from Python helpers:

- `build_task_prompt`
- `build_time_limit_message`
- `build_shutdown_message`
- `build_compaction_instructions`
- `has_task_result`
- `parse_reported_status`
- `extract_result_summary`

The required final worker block must remain:

```text
TASK_RESULT:
status: done|partial|blocked|failed
summary: <short summary>
changes:
- <changed item or "none">
verification:
- <command/result or "not run">
remaining:
- <remaining item or "none">
```

Keep status sets compatible with the Python script:

- done-like: `done`, `complete`, `completed`, `success`, `succeeded`
- partial-like: `partial`, `incomplete`, `blocked`, `failed`, `failure`, `unknown`

**Verify:**
- Add tests for parsing final assistant messages with and without fenced text.
- Add tests for status extraction from a `TASK_RESULT` block.

**Done when:** Prompt builders and result parsers are available as reusable TypeScript functions.

---

## TODO 5 — Implement native Pi SDK worker session runner

**Goal:** Replace `pi --mode rpc` worker subprocesses with isolated native Pi SDK sessions.

**Status:**
- [ ] Create isolated worker session factory
- [ ] Disable extension discovery for worker sessions
- [ ] Run one assigned task prompt
- [ ] Capture streaming events and final assistant text
- [ ] Handle abort and timeout
- [ ] Return structured session outcome

**Implementation details:**
Use the Pi SDK from `@earendil-works/pi-coding-agent`, not the Python script and not `pi --mode rpc`.

Implement a function similar to:

```ts
export async function runWorkerTask(options: RunWorkerTaskOptions): Promise<SessionOutcome>;
```

Worker session requirements:
- Fresh isolated session per task.
- Use `SessionManager.inMemory(cwd)` unless a debug option later enables persistence.
- Use selected built-in coding tools.
- Load project context files such as `AGENTS.md` if practical.
- Do not discover or load extensions, especially this coordinator extension.
- Use internal defaults for model/thinking/timeouts.
- Subscribe to session events to capture text deltas, tool execution, turn ends, compaction events, and agent end.
- If no `TASK_RESULT` appears, request the required block once if the session is still usable.
- On timeout, ask for graceful `TASK_RESULT`; if still running, abort.
- Respect the tool execution `AbortSignal` from the outer extension.

This task may need to consult Pi SDK docs/examples for exact `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, and extension-disabling APIs.

**Verify:**
- Add a fake or mocked worker-session test if practical.
- If live model calls are available, run one minimal smoke task in a disposable directory with commit disabled.

**Done when:** A native SDK worker can execute one assigned task and return a structured `SessionOutcome` without spawning `pi --mode rpc`.

---

## TODO 6 — Implement coordinator orchestration loop

**Goal:** Wire TODO generation, parsing, worker sessions, result writing, retries, and completion marking into the main coordinator.

**Status:**
- [ ] Create run directory and artifact paths
- [ ] Generate or normalize TODO markdown from `inputText`
- [ ] Run incomplete tasks sequentially
- [ ] Retry tasks up to internal max attempts
- [ ] Mark tasks done when worker reports done
- [ ] Append task results to result markdown
- [ ] Return final coordinator summary

**Implementation details:**
Implement `src/coordinator.ts` with a public function called from the registered tool, for example:

```ts
export async function runCoordinator(options: RunCoordinatorOptions): Promise<CoordinatorResult>;
```

Internal defaults should include:

```ts
maxAttemptsPerTask = 3;
taskTimeoutMs = 900_000;
maxBashTimeoutMs = 300_000;
taskThinking = "high";
todoThinking = "xhigh";
```

The loop should be sequential:

```text
create run dir
write TODO.md
while incomplete task exists:
  run worker for first incomplete task
  append result
  if done: mark task done
  if max attempts exceeded: stop with failure
return summary
```

Artifacts should live under:

```text
tmp/pi-coordinator/<run-id>/
  TODO.md
  TASK_RESULT.md
```

Do not use a public tool parameter for artifact path, models, timeouts, attempts, or TODO file path.

**Verify:**
- Use mocked worker outcomes to test sequential orchestration.
- Confirm done tasks are marked and failed tasks stop after max attempts.

**Done when:** The extension tool can call one coordinator function that drives an end-to-end run using the native worker runner.

---

## TODO 7 — Implement git commit safety and artifact exclusion

**Goal:** Add safe optional commit behavior matching the Python coordinator.

**Status:**
- [ ] Detect git root
- [ ] Capture pre-existing dirty paths
- [ ] Stage worker changes after each task
- [ ] Unstage coordinator artifacts
- [ ] Unstage pre-existing dirty paths
- [ ] Commit only when staged diff exists and outcome is eligible
- [ ] Record commit hash or commit error in result details

**Implementation details:**
Implement `src/git.ts` with argv-based child process execution, not shell string execution.

Port these behaviors:

- `git_root`
- `git_dirty_paths`
- `unstage_paths`
- `should_commit_outcome`
- `commit_after_session`

Safety requirements:
- Never commit `TASK_RESULT.md`.
- Never commit generated `TODO.md`.
- Never commit any file under `tmp/pi-coordinator/<run-id>/`.
- Never commit files that were already dirty before the current worker session started.
- Do not commit if the worker session had a coordinator/session error.
- Do not commit if there is no staged diff.
- Use commit messages like `Complete TODO 1 — Title` or `Progress TODO 1 — Title`.

**Verify:**
- Add tests in a temporary git repository if practical.
- Confirm pre-existing dirty files are left uncommitted.
- Confirm coordinator artifacts are left uncommitted.

**Done when:** `commit: true` safely commits only eligible task changes and reports commit hashes/errors.

---

## TODO 8 — Add tool streaming updates and structured result details

**Goal:** Make the outer Pi tool pleasant to use while the coordinator runs.

**Status:**
- [ ] Emit progress through `onUpdate`
- [ ] Return concise final text
- [ ] Return structured details
- [ ] Optionally add compact custom rendering

**Implementation details:**
In `src/index.ts` and/or `src/render.ts`, report progress like:

```text
Creating TODO plan...
Running TODO 1 — Add tests...
TODO 1 done, commit abc123
Running TODO 2 — Fix implementation...
TODO 2 blocked
```

Final tool result text should include:
- overall status
- completed/failed/blocked task counts
- result file path
- TODO file path
- commit hashes if any
- remaining tasks if any

Structured `details` should include:

```ts
{
  runId: string;
  todoPath: string;
  resultPath: string;
  outcomes: SessionOutcome[];
  commits: Array<{ taskId: string; hash?: string; error?: string }>;
  status: "done" | "partial" | "blocked" | "failed";
}
```

A custom renderer is optional. If implemented, keep it compact and readable in collapsed mode.

**Verify:**
- Run a coordinator smoke test or mocked run and confirm progress updates are visible.
- Confirm final result includes artifact paths and machine-usable details.

**Done when:** Users can see meaningful live progress and receive a useful final result from the tool.

---

## TODO 9 — Add automated tests for pure coordinator logic

**Goal:** Cover the high-risk pure logic with automated tests.

**Status:**
- [ ] Add test runner configuration if needed
- [ ] Test TODO parser
- [ ] Test TODO generator
- [ ] Test result parser
- [ ] Test orchestration with mocked workers
- [ ] Test git safety helpers where practical

**Implementation details:**
Add a lightweight TypeScript test setup inside `~/Sites/pi-coordinator`. Use the project/package convention that fits best, for example Vitest, Node's built-in test runner, or another minimal setup.

Test cases should include:

- no task headings raises/returns validation error
- progress checklist controls done status
- status checkboxes control done status when progress is absent
- `markTaskDone` updates progress and status checkboxes
- raw bullet lists generate multiple TODO sections
- existing TODO markdown gains missing progress section
- `TASK_RESULT` status parsing handles done, partial, blocked, failed, and unknown
- orchestrator stops after max attempts
- commit helper excludes pre-existing dirty paths and generated artifacts

Avoid live model calls in automated tests. Mock worker session outcomes.

**Verify:**
- Run the package test command.
- Ensure tests do not require network/API keys.

**Done when:** Pure logic and orchestration behavior are covered by offline automated tests.

---

## TODO 10 — Add documentation and smoke-test instructions

**Goal:** Document installation, usage, guarantees, and migration from the Python coordinator.

**Status:**
- [ ] Add package README
- [ ] Document public tool schema
- [ ] Document safety guarantees
- [ ] Document install/load commands
- [ ] Document smoke tests
- [ ] Document current limitations

**Implementation details:**
Create `~/Sites/pi-coordinator/README.md`.

Include:

- what the extension does
- install options:
  - `pi -e ~/Sites/pi-coordinator`
  - `pi install ~/Sites/pi-coordinator`
- exact public tool schema:

```ts
{
  inputText: string;
  commit: boolean;
}
```

- example user prompts:

```text
Use pi_todo_coordinator with inputText "add tests for X and fix failures" and commit false.
```

- safety guarantees:
  - no dependency on `scripts/pi_todo_coordinator.py`
  - no `pi --mode rpc` subprocesses
  - isolated native SDK worker sessions
  - worker sessions do not recursively load the coordinator extension
  - coordinator artifacts are never committed
  - pre-existing dirty files are never committed

- limitations:
  - sequential execution initially
  - model/API availability required for real runs
  - custom model/timeouts are internal defaults for now

- smoke-test command suggestions.

**Verify:**
- Follow the README commands in a disposable project or with offline load-only checks.

**Done when:** A future user can install, invoke, and validate the native extension without reading the implementation.
