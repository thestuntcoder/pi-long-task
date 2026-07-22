# Pi and runtime compatibility review

Review date: 2026-07-22. This review covers compatibility only: extension APIs, TUI integration, isolated Pi SDK sessions, package/module metadata, runtime requirements, and unavailable optional capabilities. Correctness findings are tracked separately in `docs/plugin-correctness-audit.md`.

## Validated matrix

| Component                        | Validated                              | Result                                                                                                                                                            |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi / SDK current line            | Pi `0.81.1` on Node `22.22.3`          | Extension discovery and activation passed without stderr; current `ModelRuntime` worker initialization passed with an empty agent directory.                      |
| Pi / SDK ModelRuntime floor      | Pi `0.80.8` on Node `22.22.3`          | Packaged activation, source type-check, and `ModelRuntime` worker initialization passed.                                                                          |
| Pi / SDK legacy-worker line      | Pi `0.80.7` on Node `22.22.3`          | Packaged extension discovery, activation, source type-check against the old SDK, and legacy `AuthStorage`/`ModelRegistry` worker initialization passed.           |
| TypeScript development toolchain | TypeScript `6.0.3`                     | Declared `tsc --noEmit` check passed. Pi loads the distributed `.ts` entry point through its supported loader, so the package intentionally has no emitted build. |
| Operating environment            | macOS 26.5.2, Darwin arm64, Git 2.38.1 | Automated checks and SDK probes passed. Linux, Windows, and other CPU architectures were not available in this session.                                           |

The package now declares Node `>=22.19.0`. This matches the engine requirement published by both validated Pi versions and accurately covers the native TypeScript test command. Only Node `22.22.3` was available for execution; the exact lower-bound runtime was not exercised.

Pi package core imports remain wildcard peer dependencies, as required by the Pi package documentation. The `^0.81.1` development dependencies select the current compile/test line. The wildcard peers deliberately do not encode a minimum Pi release, so the validated versions above—not peer resolution alone—define the tested matrix.

## Pi API assessment

The extension entry point and manifest follow the documented package contract:

- `package.json` declares ESM and registers `./src/index.ts` through `pi.extensions`.
- The default factory receives `ExtensionAPI` and registers tools and hooks synchronously.
- The `input` hook returns documented `continue`/`transform` actions and bypasses extension-injected input.
- The `message_end` hook preserves the assistant role while returning a replacement message with amended usage cost.
- Both custom tools use the documented `execute(toolCallId, params, signal, onUpdate, ctx)` signature, publish partial `AgentToolResult` updates, return text content plus serializable details, and pass cancellation into orchestration.
- Tool call/result renderers return Pi TUI `Component` instances and handle partial and expanded states.

No deprecated extension registration, event name, or custom-tool signature was found against Pi 0.81.1 documentation or the installed examples.

## TUI and mode behavior

The sidebar uses supported `setWidget()` component factories and `ctx.ui.custom()` overlay options. Overlay creation is restricted to TUI mode, uses a non-capturing handle, and is contained by `try`/promise rejection handling. A normal widget remains available if overlay registration fails. Components render from current state and explicitly request a TUI render after updates.

Mode handling degrades as intended:

- TUI: component widget plus responsive, non-capturing overlay.
- RPC: string-array widget path; no TUI component factory or overlay.
- JSON/print: `ctx.hasUI` is false, so no sidebar controller is created.
- Missing UI context: controller creation returns `undefined`; tool execution and partial result updates continue.

The overlay API is still documented as experimental. A future Pi overlay change should affect only the enhancement: registration failures are caught and the widget remains. The widget factory is the stable TUI fallback.

## Isolated SDK sessions

Pi 0.81.1 uses the documented `ModelRuntime.create({ authPath, modelsPath })` path and passes `modelRuntime` to `createAgentSession()`. Pi 0.80.7 successfully uses the retained legacy `AuthStorage.create()` / `ModelRegistry.create()` path. Both lines use supported `SettingsManager`, `DefaultResourceLoader`, `SessionManager.inMemory()`, selected built-in tool names, subscriptions, and session disposal.

The worker resource-loader adapter satisfies the complete `ResourceLoader` interface present on both validated lines and replaces extension discovery with an empty extension runtime. This prevents recursive loading of Pi Long Task while preserving skills, prompts, themes, context files, and system-prompt methods.

Worker event handling matches documented `AgentSession` events (`message_*`, `turn_end`, `tool_execution_*`, `compaction_end`, and `agent_end`). The implementation also tolerates unknown or missing event fields for compatibility. Lifecycle correctness concerns such as bounded cancellation are not compatibility changes and remain in the separate correctness audit.

## Package and runtime assessment

- Module format: ESM with explicit `.ts` relative imports, supported by Pi's TypeScript loader and by the declared NodeNext type-check configuration.
- Package entry: no conventional `main`/`exports` is needed because this is a Pi package, not a compiled JavaScript library. The `pi.extensions` manifest is the runtime entry point.
- Published files: `src`, `scripts`, `README.md`, and `LICENSE` include the extension entry point and native smoke script. No runtime import depends on omitted repository files.
- Core dependencies: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are wildcard peers exactly as Pi package guidance requires.
- Development dependencies and lockfile: current Pi packages resolve together at `0.81.1`; TypeScript and lint/test tooling are development-only.
- External executables: normal non-commit operation does not require Git. Commit mode reports `not inside a git repository` when repository support is unavailable instead of crashing orchestration.

## Unavailable and optional capabilities

The current and legacy worker initialization probes used newly created agent directories with no `auth.json` or `models.json`; session construction succeeded with no diagnostics. This confirms that absence of optional credential/model files does not prevent package loading or SDK session creation. Actual planner, worker, and reviewer prompts still require a usable model credential and can surface missing-credential failures through task results.

Headless activation completed with `PI_OFFLINE=1`, confirming that extension loading does not require network access or credentials. The credentialed `npm run smoke:native` flow was not run because it invokes paid model sessions. Its commit-off and commit-on scenarios remain a release-readiness gate once credentials are intentionally available.

## Compatibility risks and follow-up

1. **Future Pi releases:** wildcard core peers are mandated by Pi packaging, so npm cannot prevent loading against a future breaking SDK. Keep current-Pi activation, type-checking, and native smoke in release validation.
2. **Older Pi releases:** Pi 0.80.7 is the oldest version exercised here. The legacy feature-detection path may support earlier versions, but they are not claimed as validated.
3. **Minimum Node boundary:** Node 22.19 itself was unavailable; compatibility is inferred from the identical engine floor of both validated Pi releases and successful Node 22.22.3 checks.
4. **Operating systems:** Linux and Windows were not exercised. Runtime code uses cross-platform Node APIs and invokes Git with argument arrays, but release confidence on those systems requires CI or manual smoke coverage.
5. **Experimental overlay:** the right-side overlay depends on an experimental Pi TUI API. Failure is contained and falls back to the widget, but visual behavior should be checked when updating Pi TUI.
6. **Native model execution:** activation and SDK construction passed, but paid/credentialed planner-worker-reviewer execution was not repeated during this compatibility task. `npm run smoke:native` remains outstanding for the final release review.

No source-level compatibility defect was confirmed. The only compatibility correction made in this task is declaring the Node engine floor and replacing ambiguous runtime wording with the validated matrix and explicit limitations.

## Verification record

- `PI_OFFLINE=1 pi --mode json --no-extensions -e /Users/dj/Sites/pi-coordinator --no-session` — Pi 0.81.1 exited 0, emitted one JSON event, and wrote no stderr.
- Current SDK empty-agent probe using `createIsolatedWorkerSession({ tools: [] })` — created and disposed a session with no diagnostics and no fallback warning when `auth.json` and `models.json` were absent.
- Disposable Pi 0.80.8 package matrix — packed the extension, installed exact 0.80.8 Pi core packages, activated it headlessly with no stderr, initialized/disposed a `ModelRuntime` worker session from an empty agent directory, and type-checked the packaged source against 0.80.8 declarations.
- Disposable Pi 0.80.7 package matrix — packed the extension, installed exact 0.80.7 Pi core packages, activated it headlessly with no stderr, initialized/disposed a legacy worker session from an empty agent directory, and type-checked the packaged source against 0.80.7 declarations.
- Non-Git commit probe — returned `{ "error": "not inside a git repository" }` without throwing.
- Full declared checks and package metadata checks are recorded in the task result after the final post-change run.
