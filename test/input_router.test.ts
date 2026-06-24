import assert from "node:assert/strict";

import {
  inferCommitSetting,
  inferGoalSetting,
  isNaturalLanguageLongTaskRequest,
  longTaskInputTransform,
  parseLongTaskRequestOptions,
} from "../src/input_router.ts";

const withCommits = longTaskInputTransform("Run a long task with commits to add natural-language routing.");
assert.ok(withCommits);
assert.match(withCommits, /Use the pi_long_task tool/);
assert.match(withCommits, /Set commit to true\./);
assert.match(withCommits, /Do not rely on inputText for parsed options/);
assert.match(withCommits, /Run a long task with commits to add natural-language routing\./);

const withoutCommits = longTaskInputTransform("Please start a long task without commits: clean up docs.");
assert.ok(withoutCommits);
assert.match(withoutCommits, /Set commit to false\./);

const defaultNoCommits = longTaskInputTransform("Run a long task to clean up docs.");
assert.ok(defaultNoCommits);
assert.match(defaultNoCommits, /Set commit to false\./);
assert.doesNotMatch(defaultNoCommits, /Set goal to/);

const coverageGoalPhrase = "run long task with commits with goal to have testing line coverage above 80%";
const coverageOptions = parseLongTaskRequestOptions(coverageGoalPhrase);
assert.deepEqual(coverageOptions, {
  commit: true,
  goal: "have testing line coverage above 80%",
});
const coverageTransform = longTaskInputTransform(coverageGoalPhrase);
assert.ok(coverageTransform);
assert.match(coverageTransform, /Set commit to true\./);
assert.match(coverageTransform, /Set goal to "have testing line coverage above 80%"\./);
assert.match(coverageTransform, /Do not rely on inputText for parsed options/);

assert.deepEqual(parseLongTaskRequestOptions("run a long task to get line coverage at least 91.5%"), {
  commit: false,
  goal: "get line coverage at least 91.5%",
});
assert.deepEqual(parseLongTaskRequestOptions("run long task commit:on goal: line coverage over 77%"), {
  commit: true,
  goal: "line coverage over 77%",
});

assert.equal(isNaturalLanguageLongTaskRequest("How do I run a long task with commits?"), false);
assert.equal(isNaturalLanguageLongTaskRequest("Do not run a long task with commits yet."), false);
assert.equal(isNaturalLanguageLongTaskRequest("Use pi_long_task with inputText x and commit true."), false);
assert.equal(isNaturalLanguageLongTaskRequest("Run tests with commits."), false);

assert.equal(inferCommitSetting("commit as you go"), true);
assert.equal(inferCommitSetting("with commits"), true);
assert.equal(inferCommitSetting("don't commit"), false);
assert.equal(inferCommitSetting("without commits"), false);
assert.equal(inferCommitSetting("no preference"), undefined);

assert.equal(inferGoalSetting("run long task with goal to reach 90% line coverage"), "reach 90% line coverage");
assert.equal(
  inferGoalSetting("run long task with goal to reach 90% line coverage with commits"),
  "reach 90% line coverage",
);
assert.equal(inferGoalSetting("run long task with commits"), undefined);
