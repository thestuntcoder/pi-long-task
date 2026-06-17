import assert from "node:assert/strict";

import { inferCommitSetting, isNaturalLanguageLongTaskRequest, longTaskInputTransform } from "../src/input_router.ts";

const withCommits = longTaskInputTransform("Run a long task with commits to add natural-language routing.");
assert.ok(withCommits);
assert.match(withCommits, /Use the pi_long_task tool/);
assert.match(withCommits, /Set commit to true\./);
assert.match(withCommits, /Run a long task with commits to add natural-language routing\./);

const withoutCommits = longTaskInputTransform("Please start a long task without commits: clean up docs.");
assert.ok(withoutCommits);
assert.match(withoutCommits, /Set commit to false\./);

const defaultNoCommits = longTaskInputTransform("Run a long task to clean up docs.");
assert.ok(defaultNoCommits);
assert.match(defaultNoCommits, /Set commit to false\./);

assert.equal(isNaturalLanguageLongTaskRequest("How do I run a long task with commits?"), false);
assert.equal(isNaturalLanguageLongTaskRequest("Do not run a long task with commits yet."), false);
assert.equal(isNaturalLanguageLongTaskRequest("Use pi_long_task with inputText x and commit true."), false);
assert.equal(isNaturalLanguageLongTaskRequest("Run tests with commits."), false);

assert.equal(inferCommitSetting("commit as you go"), true);
assert.equal(inferCommitSetting("with commits"), true);
assert.equal(inferCommitSetting("don't commit"), false);
assert.equal(inferCommitSetting("without commits"), false);
assert.equal(inferCommitSetting("no preference"), undefined);
