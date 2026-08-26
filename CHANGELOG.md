# Changelog

Notable changes to Pi Long Task are recorded here. This project follows semantic versioning.

## 0.3.17 - 2026-08-26

### Fixed

- Prevent repeated `Finished:` and `Failed:` prefixes from accumulating in the sidebar's active status across tool events.
- Reset the active status at every tool start so a completed tool's status cannot leak into the next tool.

## 0.3.16 - 2026-08-20

### Changed

- Make the sidebar's "Active status" follow live worker commentary and tool activity instead of repeating a generic coordinator message.
- Show active bash commands and read, edit, and write paths, including tool completion or failure state.
- Preserve the latest worker activity across unrelated cost updates while keeping the compact fallback layout unchanged.

## 0.3.15 - 2026-08-20

### Changed

- Show the full active task status in a dedicated "Active status" section below the active task in the TUI sidebar, wrapping instead of truncating long status messages.
- Wrap the active task status message and current task line in the plain widget fallback instead of hard-truncating them.

## 0.3.14 - 2026-08-20

### Documentation and metadata

- Improve npm and GitHub discoverability with a richer package description, expanded keywords, and added `repository`, `homepage`, `bugs`, and `engines` fields.
- Add npm version, Node.js, and license badges, a keyword-rich introduction, and the embedded package preview image to the README.

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
