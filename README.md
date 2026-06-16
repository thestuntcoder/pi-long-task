# Pi TODO Coordinator Extension

Native Pi extension package that coordinates TODO-style work across isolated Pi SDK worker sessions. It is intended to replace the older `scripts/pi_todo_coordinator.py` workflow with a first-class Pi tool named `pi_todo_coordinator`.

## What it does

`pi_todo_coordinator` accepts a high-level request or TODO markdown, creates/normalizes a TODO plan, and runs the incomplete TODO tasks one at a time in native Pi SDK worker sessions. Each worker receives exactly one assigned task, reports a `TASK_RESULT` block, and the coordinator records run artifacts under `tmp/pi-coordinator/<run-id>/`.

When `commit` is `true`, the coordinator may commit eligible worker changes after each completed/progress task. When `commit` is `false`, no commits are made.

## Installation and loading

From any project where you want to use the coordinator:

```bash
pi -e ~/Sites/pi-coordinator
```

This loads the local package for the current Pi session only.

To install it as a Pi package:

```bash
pi install ~/Sites/pi-coordinator
```

After installing, start `pi` normally in the target project and ask the model to use the `pi_todo_coordinator` tool.

For an isolated smoke test that ignores other configured extensions, use:

```bash
PI_OFFLINE=1 pi --mode json --no-extensions -e ~/Sites/pi-coordinator --no-session
```

## Public tool schema

The extension exposes one public tool, `pi_todo_coordinator`, with exactly this input shape:

```ts
{
  inputText: string;
  commit: boolean;
}
```

No other public coordinator tool inputs are supported.

## Usage examples

In a Pi session with the extension loaded, prompt the agent explicitly:

```text
Use pi_todo_coordinator with inputText "add tests for X and fix failures" and commit false.
```

To allow the coordinator to commit eligible worker changes:

```text
Use pi_todo_coordinator with inputText "implement the TODOs in @TODO.md" and commit true.
```

For a pasted TODO plan:

```text
Use pi_todo_coordinator with inputText "<paste TODO markdown here>" and commit false.
```

## Safety guarantees

- The native extension does not depend on `scripts/pi_todo_coordinator.py`.
- The native extension does not spawn `pi --mode rpc` subprocesses.
- Worker tasks run in isolated native Pi SDK worker sessions.
- Worker sessions are configured not to recursively load the coordinator extension.
- Coordinator artifacts are written under a run directory such as `tmp/pi-coordinator/<run-id>/` and are never committed by the coordinator.
- `TASK_RESULT.md`-style coordinator result artifacts are never committed by the coordinator.
- Files that were already dirty before a worker task started are excluded from coordinator commits.
- Workers are instructed not to run `git commit`; commits, when enabled, are performed only by the coordinator after a worker session finishes.

## Migration from the Python coordinator

Use this extension instead of invoking `scripts/pi_todo_coordinator.py` directly.

Old workflow conceptually:

```bash
python scripts/pi_todo_coordinator.py "add tests for X and fix failures"
```

New workflow:

```bash
pi -e ~/Sites/pi-coordinator
```

Then ask Pi:

```text
Use pi_todo_coordinator with inputText "add tests for X and fix failures" and commit false.
```

If you previously enabled Python-side commits, pass `commit true` instead. The native extension keeps generated coordinator artifacts under `tmp/pi-coordinator/<run-id>/` and avoids committing pre-existing dirty files.

## Smoke tests

Suggested checks:

1. Run package checks from the extension directory:

   ```bash
   cd ~/Sites/pi-coordinator
   npm run check
   ```

2. Offline load-only check, without loading your normal extension set:

   ```bash
   PI_OFFLINE=1 pi --mode json --no-extensions -e ~/Sites/pi-coordinator --no-session
   ```

   Expected: Pi starts, emits a JSON session line, and exits without extension-load errors.

3. Automated native end-to-end smoke through Pi:

   ```bash
   npm run smoke:native
   ```

   This creates disposable git repos, invokes `pi_todo_coordinator` through `pi -p --mode json --no-extensions -e <this package>`, and verifies both `commit: false` and `commit: true`. It requires usable model/API credentials for Pi and the coordinator worker model. Useful options:

   ```bash
   PI_SMOKE_MODEL=openai-codex/gpt-5.5:minimal npm run smoke:native
   PI_SMOKE_KEEP=1 npm run smoke:native
   ```

4. Manual disposable real run with commits disabled:

   ```bash
   tmpdir=$(mktemp -d)
   cd "$tmpdir"
   git init
   printf '# Scratch\n' > README.md
   git add README.md && git commit -m 'init'
   pi --no-extensions -e ~/Sites/pi-coordinator --no-session
   ```

   Then prompt:

   ```text
   Use pi_todo_coordinator with inputText "add a sentence to README.md and verify with cat README.md" and commit false.
   ```

   Expected: the tool runs only if a usable model/API login is available; no commits are created because `commit` is `false`.

5. Optional manual disposable commit check:

   Repeat the previous test with `commit true`, then inspect:

   ```bash
   git log --oneline --decorate -5
   git status --short
   ```

   Expected: eligible worker changes may be committed, while coordinator artifacts and any files dirty before the task remain uncommitted.

## License

MIT. See [LICENSE](LICENSE).

## Current limitations

- Task execution is sequential initially.
- Real coordinator runs require available model/API credentials or an active Pi login.
- Custom model selection and timeout values are internal defaults for now.
- The public tool schema is intentionally narrow; callers must use only `inputText` and `commit`.
