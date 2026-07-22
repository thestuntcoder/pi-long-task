# Changelog

Notable changes to Pi Long Task are recorded here. This project follows semantic versioning.

## 0.3.13 - 2026-07-22

### Fixed

- Require complete, machine-readable worker results and reject false completion after session errors, timeouts, or cancellation.
- Bound worker and reviewer cancellation even when an SDK prompt or graceful follow-up does not settle.
- Preserve checked TODO progress, durable attempt ordering, retry commit baselines, and accurate failure evidence.
- Resume persisted goal-loop phases without repeating completed generation or execution work.
- Enforce overall and iteration deadlines consistently across generation, execution, and review.
- Retain structured terminal goal results and persisted cost totals across cancellation, failure, and resume paths.

### Compatibility and maintenance

- Declare the supported Node.js floor as 22.19.0 and document validation against Pi 0.80.7, 0.80.8, and 0.81.1.
- Refresh the controllable transitive development lockfile resolutions for `brace-expansion` and `protobufjs`.
