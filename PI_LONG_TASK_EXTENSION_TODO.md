# Pi Long Task TODO

This file records the completed implementation checklist for the Pi Long Task extension.

## Done

- [x] Create a standalone Pi package.
- [x] Register the `pi_long_task` tool with `{ inputText, commit }` inputs.
- [x] Generate or normalize TODO markdown from a broad request.
- [x] Parse TODO tasks and mark completed work.
- [x] Run one focused worker session per task.
- [x] Record run artifacts under `tmp/pi-long-task/<run-id>/`.
- [x] Return concise summaries and structured details.
- [x] Optionally commit eligible task changes.
- [x] Avoid committing generated artifacts and pre-existing dirty files.
- [x] Add automated tests, type checking, linting, formatting, and native smoke tests.
- [x] Add compact Pi tool rendering.
- [x] Rename the package and tool around the long-task workflow.

## Current public interface

Package name:

```bash
pi-long-task
```

Install command after npm publish:

```bash
pi install npm:pi-long-task
```

Tool name:

```text
pi_long_task
```

Tool input:

```ts
{
  commit: boolean;
  inputText?: string;
  goal?: string;
}
```

## Validation

Run:

```bash
npm run check
npm run smoke:native
```
