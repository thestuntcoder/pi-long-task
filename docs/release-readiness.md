# Pi Long Task 0.3.13 release-readiness review

Review date: 2026-07-22.

## Recommendation

**Do not publish yet.** The reviewed package behavior and packaged native smoke are green, but the repository is not release-ready until the completed correctness fixes and release files are committed as focused changes and the final clean-tree gate is repeated. The release candidate is versioned `0.3.13`, a patch release from the published and tagged `0.3.12`.

After those commits exist, rerun `npm ci`, `npm run check`, `npm pack --dry-run --json`, and `git status --short --branch` from a clean checkout. If those commands reproduce this review, `0.3.13` is recommended for tagging and publication.

## Metadata and package contents

- `package.json` and the root lockfile metadata agree on version `0.3.13`; npm reports `0.3.12` as the currently published `latest`, so a patch increment is required before publication.
- The package is ESM, requires Node `>=22.19.0`, and declares `./src/index.ts` through `pi.extensions`. A conventional `main`, `exports`, or emitted JavaScript build is intentionally unnecessary because Pi loads TypeScript package extensions directly.
- Pi-provided runtime modules (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) remain wildcard peer dependencies, matching Pi package guidance. Test, lint, and type-check tooling remains development-only.
- The published allowlist contains `CHANGELOG.md`, `LICENSE`, `README.md`, `scripts`, and `src`. The dry-run contains 27 expected files, including the extension entry point and native smoke script, with no tests, review notes, temporary artifacts, dependency tree, or secrets.
- There is no emitted build step. `npm run typecheck` is the build-equivalent validation, and the packaged extension is exercised through Pi's supported loader.

## Documentation and release notes

The README matches the reviewed behavior for complete `TASK_RESULT` requirements, timeout/cancellation handling, preserved checked progress, commit safety, Pi/runtime support, direct TypeScript loading, and native validation. `CHANGELOG.md` now records the user-visible fixes and compatibility updates in `0.3.13`. This repository did not previously maintain a changelog; adding it to the package gives consumers release notes without publishing internal audit documents.

## Validation results

- `npm ci` — passed on Node `22.22.3` with npm `10.9.8`; 319 packages installed from lockfile version 3.
- `npm run check` — passed: Prettier, ESLint, TypeScript no-emit checking, and all 37 Node test-runner tests (37 passed, 0 failed, 0 skipped).
- `npm pack --dry-run --json` — passed for `pi-long-task@0.3.13`; 27 expected files, approximately 93 KB packed and 411 KB unpacked, with no bundled dependencies.
- Packaged native smoke — passed by creating an actual `0.3.13` tarball, extracting it, loading that extracted package with `pi -e`, and executing representative `pi_long_task` runs against `openai-codex/gpt-5.5:minimal`. Both `commit: false` and `commit: true` completed, wrote and verified their marker files, and the commit-enabled case created exactly one eligible commit.
- `git diff --check` — passed.
- Package/runtime compatibility remains validated on Pi `0.80.7`, `0.80.8`, and `0.81.1` as recorded in [`pi-runtime-compatibility.md`](pi-runtime-compatibility.md).

## Commit-history and clean-tree gate

The four review commits currently present are focused and understandable:

1. `Establish Baseline and Review Scope`
2. `Audit Plugin Correctness`
3. `Verify Pi and Runtime Compatibility`
4. `Assess Regression Coverage`

The final correctness/fix work and this release-readiness work were still uncommitted at the last status check. Because the worker is explicitly prohibited from running `git commit`, this is a release-process blocker rather than an unverified code-path failure. No tag or npm publication should occur until the coordinator records the expected focused commits and the tree is clean.

## Remaining risks

1. A moderate `protobufjs` advisory remains in a duplicated transitive tree under the `@earendil-works/pi-coding-agent` development dependency. The top-level compatible resolution is refreshed, but npm continues to install the nested `7.6.4` copy. It is development-only, is not bundled in the package tarball, and is inherited from the validated Pi SDK package; update the Pi development dependency when an upstream release removes the duplicate.
2. Only macOS arm64 and Node `22.22.3` were exercised. The declared Node `22.19.0` floor, Linux, Windows, and other architectures remain inferred from Pi's support and cross-platform APIs rather than directly tested here.
3. The right-side overlay uses Pi's experimental TUI overlay API. Failure remains contained by the widget fallback, but visual behavior should be checked when upgrading Pi.
4. Wildcard Pi peer ranges are required by Pi packaging and cannot prevent a future breaking SDK release. Continue current-Pi activation and native smoke checks for each release.
5. The lower-priority parser, cleanup-diagnostic, and injected-discovery-runner limitations in [`fix-validation.md`](fix-validation.md) remain non-blocking follow-up work.
