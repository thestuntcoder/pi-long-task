# Pi Long Task regression coverage assessment

Assessment date: 2026-07-22. This review evaluates automated protection for the direct long-task and goal-loop lifecycles. It does not change runtime behavior and is not a release-readiness decision. Confirmed implementation defects remain tracked in [`plugin-correctness-audit.md`](plugin-correctness-audit.md) for the dedicated fix task.

## Method and references

The suite was compared with the installed Pi 0.81.1 extension and SDK contracts, especially custom-tool cancellation, `AgentSession.prompt()`/`abort()`/`subscribe()`/`dispose()`, in-memory worker sessions, input transforms, and headless/TUI mode behavior. The installed `extensions.md` and `sdk.md` documentation and their tool, input-transform, and full-control session examples were consulted.

The full suite was run normally and with Node's experimental test coverage. Coverage is a navigation aid rather than the acceptance criterion: lifecycle assertions and durable state outcomes matter more than executing incidental branches.

## Existing behavior coverage

| Area                   | Meaningful automated protection before this assessment                                                                                                                                                                        | Remaining limitation                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct success         | Sequential task selection, persisted completion, result records, progress snapshots, worker events/cost, configured models/timeouts, and optional commit decisions.                                                           | Native credentialed planner/worker behavior is intentionally outside unit tests.                                                                                                                 |
| Direct failure/retry   | Partial retry exhaustion, blocked and failed outcomes, missing credentials, commit ineligibility, planner failure, and accurate ordinary failure artifacts.                                                                   | Escaped worker exceptions currently lose known task counts; malformed/error-bearing `done` can be trusted.                                                                                       |
| Interruption           | Planner timeout/abort has bounded cleanup; worker outer abort is tested when the fake prompt settles after `abort()`.                                                                                                         | A worker/reviewer prompt that does not settle after abort can hang. Active goal child-phase cancellation is not finalized consistently.                                                          |
| Resume/persistence     | Goal-state save/load and ordinary multi-iteration continuation are covered.                                                                                                                                                   | Persisted `todo_generated` and `todo_executed`/`failed` phases cannot resume; direct checked-TODO normalization loses completed progress; resumed goal artifacts can be rewritten or duplicated. |
| Malformed input/output | Invalid planner output gets one repair, final planner failure skips workers, missing worker status gets one reminder, reviewer JSON parsing accepts supported forms, and a no-task parse fails.                               | TODO section boundaries are too permissive, result blocks are structurally under-validated, and stale fenced results can beat a later final block.                                               |
| Pi compatibility       | Modern `ModelRuntime`, legacy auth/model registry, extension-disabled resource loading, tool registration, input routing, mode guards, widgets/overlays, and renderers are exercised without paid model calls.                | OS/runtime matrix and native credentialed smoke remain release checks, not unit tests.                                                                                                           |
| Goal loop              | Discovery/direct routing, persisted specs, generation, execution, reviewer-complete/incomplete/blocked/failure decisions, minimum/max iterations, initial cancellation, trace/state/result persistence, and cost propagation. | Reviewer session errors can be overridden by parseable output; deadlines and active cancellation are not enforced at every phase.                                                                |

## Added regression protection

`test/regression_coverage.test.ts` adds public-behavior tests for gaps that are correct today and should remain stable:

1. **Interruption between direct tasks:** after one task is durably completed, cancellation stops later workers, returns accurate partial counts, leaves the next TODO pending, and preserves the first attempt record.
2. **Malformed TODO documents:** missing separators, non-sequential IDs, missing required status headings, and documents without task sections are rejected through the public validator.
3. **Malformed reviewer output:** invalid reviewer text is persisted, converted to a failed review, and reflected in durable goal state instead of being lost as an unrecorded exception.
4. **Supported resume boundary:** a persisted `reviewed_incomplete` state continues with exactly the next iteration and retains the previous reviewed iteration.

The tests use independent temporary directories, injected deterministic runners, and durable public artifacts. They do not assert private helper call order, timestamps generated by production code, or platform-specific path formatting.

## Confirmed high-risk gaps requiring fix-coupled tests

The correctness audit confirmed the following behaviors are defective. A green regression assertion for the intended behavior cannot be enabled without changing runtime source, which belongs to the subsequent implementation task. Each fix must land with a focused test that first reproduces its original defect:

- require a complete worker `TASK_RESULT` and reject `done` when the session also errors, aborts, or times out;
- reject reviewer completion when its session reports error, abort, or timeout;
- bound worker and reviewer cancellation even when SDK `prompt()` never settles, and schedule hard abort independently from graceful-message settlement;
- preserve checked progress when a TODO artifact is normalized and resumed;
- reject an empty `**Status:**` block instead of borrowing verification checkboxes;
- retain task counts and active-task evidence when a worker runner throws;
- append attempt evidence before persisting task completion;
- resume goal orchestration from every durable phase without rewriting result/trace history;
- finalize active goal cancellation/failure consistently and enforce remaining deadlines around every child phase;
- retain the original protected dirty-path baseline across task retries;
- report success when cancellation arrives after the final trustworthy completion, rather than contradictory partial success;
- select the last result block by source position and validate all required result fields;
- contain cleanup/stat errors and account for multi-message and resumed costs consistently;
- structurally bind progress, separator, status, and task regions while ignoring fenced examples.

These are release-blocking coverage gaps, not evidence that the current green suite makes the plugin release-ready. Tests added with those fixes should assert externally visible outcomes and persisted artifacts rather than internal implementation choices.

## Coverage and verification record

- Baseline `npm test`: 25 top-level test entries passed, with 0 failures/skips/TODOs.
- `node --experimental-strip-types --experimental-test-coverage --test`: passed; aggregate source/test coverage was 91.13% lines, 76.22% branches, and 92.21% functions. Lower line coverage in reviewer, renderer, and extension integration code was reviewed qualitatively; raw percentage alone did not determine additions.
- `node --experimental-strip-types --test test/regression_coverage.test.ts`: the four added behavior tests passed independently.
- An isolated intended-behavior assertion for checked-TODO normalization exited 1 as expected on the current defect, observing `[false, false]` instead of `[true, false]`; it should become a normal green regression test with the resume fix.
- Repeated focused and full-suite results are recorded in the task result after the final run.

No paid model session or native smoke was needed for this regression assessment. The final release review still requires the credentialed native smoke and all fix-coupled regression tests above.
