# Pi Long Task Plugin Flow Audit

Audit for adding a task sidebar while keeping task execution in the existing main-thread tool flow.

## Current execution path

1. `src/index.ts` registers the extension and the `pi_long_task` tool.
   - `pi.on("input")` routes natural-language long-task requests through `longTaskInputTransform()`.
   - `pi.registerTool({ name: "pi_long_task", ... execute })` is the task execution entry point.
   - `execute()` wraps Pi `onUpdate` as `publishProgress()`, then awaits `runCoordinator({ ..., onProgress: publishProgress })`.
2. `src/coordinator.ts` owns orchestration in `runCoordinator()`.
   - Creates `tmp/pi-long-task/<run-id>/TODO.md` and `TASK_RESULT.md`.
   - Generates or normalizes TODO markdown.
   - Parses tasks with `parseTasks()` and repeatedly selects `incompleteTasks(todoMarkdown)[0]`.
   - Emits progress before planning, after planning, at task start, during worker tool events, at task outcome, and at completion.
   - Runs each task by awaiting `runtime.workerRunner(...)` (default `runWorkerTask()`) inside the same coordinator loop.
   - Marks successful tasks done in TODO markdown via `markTaskDone()`.
   - Optionally commits after the worker returns, still inside the coordinator loop.
3. `src/worker_session.ts` executes the assigned TODO in an isolated worker agent session.
   - `runWorkerTask()` builds the assigned-task prompt.
   - `createIsolatedWorkerSession()` creates a Pi agent session with built-in worker tools and extensions disabled.
   - Worker session events are captured and summarized; tool start/end events are relayed to the coordinator through `options.onEvent`.
   - The worker final `TASK_RESULT` block is parsed into `reportedStatus` / `done`.
4. `src/git.ts`, `src/result_writer.ts`, and `src/todo_parser.ts` provide supporting state transitions only; they do not own UI.

Conclusion: execution is main-thread based today because the tool `execute()` awaits `runCoordinator()`, and `runCoordinator()` awaits all worker attempts in sequence. The sidebar should observe coordinator progress from `execute()` and must not call, move, or replace `runCoordinator()` / `runWorkerTask()`.

## Current task, status, and progress state

Existing state sources:

- `TODO.md` on disk is the durable task checklist.
- `parseTasks()` returns task metadata: id, title, done state, status checkboxes, and status item text.
- `runCoordinator()` holds ephemeral arrays for `attempts`, `outcomes`, and `commits`.
- `CoordinatorProgressUpdate` currently includes message, phase, run paths, active task, active subtasks, worker tool metadata, commit metadata, status, and `totalTasks` on some updates.
- Final `CoordinatorResult` includes aggregate counts and remaining tasks.

Gap for a sidebar:

- Progress updates do not currently include the full task list, so a sidebar cannot show past/current/future tasks without reparsing `TODO.md` itself.
- Past/future task statuses are implied by `todoMarkdown`, `attempts`, and the current phase, but there is no single snapshot object for UI rendering.

## Current main-thread status display

Main-thread display is entirely through tool rendering:

- `src/index.ts` sends partial tool results with `onUpdate({ content: [{ type: "text", text: update.message }], details: update })`.
- `src/render.ts` renders partial results via `renderLongTaskProgress()` when `options.isPartial` is true.
- `renderLongTaskProgress()` shows the current TODO and parsed status checkbox subtasks when present.
- Final output is rendered by `renderLongTaskSummary()` and formatted text comes from `formatCoordinatorResultMessage()`.
- The source currently has no `ctx.ui.setWidget()`, `ctx.ui.custom()`, `setStatus()`, or sidebar-specific UI state.

This means the main thread already shows what is happening; sidebar work should be additive and leave `renderLongTaskToolResult()` active.

## Sidebar integration points

Recommended integration without relocating execution:

1. Add a shared progress snapshot shape.
   - Extend `CoordinatorProgressUpdate` or move progress types into a small shared module.
   - Include all tasks, current task id/index, aggregate counts, phase, and active subtasks.
   - Populate the snapshot inside `runCoordinator()` from `parseTasks(todoMarkdown)` rather than in UI code.
2. Keep `runCoordinator()` as the only execution orchestrator.
   - Continue emitting `onProgress` at the existing points.
   - Add full task-list data to those updates.
   - Do not start worker sessions from the sidebar.
3. Add a sidebar controller/component from the tool `execute()` path.
   - In `src/index.ts`, create the sidebar only when `ctx.mode === "tui"` / UI support is available.
   - Update it inside the same `publishProgress()` function that already calls `onUpdate`.
   - Close or clear it after `runCoordinator()` resolves or throws.
4. Keep main-thread rendering unchanged.
   - `onUpdate` should still publish partial tool results.
   - `src/render.ts` should continue to render active task/subtask status in the main conversation.
5. UI implementation options from Pi SDK docs:
   - Preferred sidebar-like TUI: `ctx.ui.custom(..., { overlay: true, overlayOptions: { anchor: "right-center", ... } })` with an updateable component and handle-driven rerender.
   - Simpler non-sidebar fallback: `ctx.ui.setWidget("pi-long-task", lines)` for environments where overlay/sidebar behavior is unavailable.

## Exact files likely needing changes later

- `src/coordinator.ts` — enrich progress updates with full task-list snapshots and aggregate progress; no execution relocation.
- `src/index.ts` — instantiate/update/cleanup sidebar in `execute()` while still calling `onUpdate` and awaiting `runCoordinator()`.
- `src/render.ts` — keep current main-thread renderer; optionally consume richer progress details without changing behavior.
- `src/types.ts` or new `src/progress.ts` — share progress/sidebar types if they outgrow `coordinator.ts`.
- New `src/sidebar.ts` — render centered task list, current task subtasks, and overall progress.
- Tests: `test/coordinator.test.ts` for progress snapshots, `test/render.test.ts` for unchanged main-thread partial rendering, and new sidebar component tests if a component is added.
- `README.md` — document the sidebar once implemented.

## Implementation constraints to preserve

- Do not move `runCoordinator()` or `runWorkerTask()` into any sidebar code.
- Do not suppress or replace partial tool result updates; the main thread must continue to show current activity.
- Sidebar state should be derived from coordinator progress snapshots, not from an independent task runner.
- Sidebar should show all tasks and center/scroll around the current task.
- Final counts and task states should come from the same parsed TODO/result data used by the coordinator.
