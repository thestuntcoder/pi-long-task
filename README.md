# Pi Long Task

Pi Long Task is a Pi extension that turns a larger coding request into a clear TODO plan, works through the tasks one by one, and reports the result.

It is useful when you want Pi to handle a multi-step change without losing track of what has been done, what is still left, and whether changes should be committed.

## What you get

When you ask Pi to use `pi_long_task`, it will:

1. Create or clean up a TODO plan from your request.
2. Work through each unfinished TODO task in order.
3. Record progress and final results under `tmp/pi-long-task/<run-id>/`.
4. Return a summary with completed, failed, blocked, and remaining task counts.
5. Optionally commit completed work after each task.

A finished run gives you:

- a concise status summary in Pi
- a generated `TODO.md`
- a generated `TASK_RESULT.md`
- commit hashes when commits were enabled and created
- any remaining or blocked tasks clearly listed

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

After installing, start `pi` in your target project and ask it to use the `pi_long_task` tool.

## Usage

Use natural language:

```text
Run a long task without commits to add tests for the parser and fix any failures.
```

```text
Run a long task with commits to implement the TODOs in @TODO.md.
```

You can also call the tool explicitly.

Run without commits:

```text
Use pi_long_task with inputText "add tests for the parser and fix any failures" and commit false.
```

Run and allow commits:

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

No other public options are required.

## Commits and files

When `commit` is `false`, Pi Long Task never creates commits.

When `commit` is `true`, it may commit eligible task changes after a task reports useful progress. It avoids committing:

- generated run files under `tmp/pi-long-task/`
- generated `TASK_RESULT.md` files
- files that were already dirty before the task started

This lets you keep existing local work separate from Pi Long Task changes.

## Validate the install

Run the local checks:

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

## Notes

- Tasks run one at a time.
- Real runs require a working Pi model/login or API key.
- Run artifacts are written under `tmp/pi-long-task/<run-id>/`.

## License

MIT. See [LICENSE](LICENSE).
