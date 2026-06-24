import assert from "node:assert/strict";

import {
  coverageGoalAction,
  coverageGoalVerification,
  inferCoverageGoalText,
  parseCoverageGoal,
} from "../src/coverage_goal.ts";

assert.deepEqual(parseCoverageGoal("have testing line coverage above 80%"), {
  thresholdPercent: 80,
  thresholdText: "80",
  relation: "above",
});

assert.deepEqual(parseCoverageGoal("keep line coverage at least 92.50%"), {
  thresholdPercent: 92.5,
  thresholdText: "92.5",
  relation: "at least",
});

assert.equal(parseCoverageGoal("increase coverage without a threshold"), undefined);
assert.equal(parseCoverageGoal("line coverage above one hundred percent"), undefined);
assert.equal(parseCoverageGoal("line coverage above 101%"), undefined);

const goal = parseCoverageGoal("line coverage >= 87.5%");
assert.ok(goal);
assert.equal(coverageGoalAction(goal), "Raise or maintain testing line coverage at least 87.5%.");
assert.equal(
  coverageGoalVerification(goal),
  "Run the repository's coverage command and confirm line coverage is at least 87.5%; report the command and resulting line coverage.",
);

assert.equal(
  inferCoverageGoalText("run long task with commits with goal to have testing line coverage above 80%"),
  "have testing line coverage above 80%",
);
assert.equal(
  inferCoverageGoalText("run a long task to get line coverage at least 91%"),
  "get line coverage at least 91%",
);
assert.equal(inferCoverageGoalText("run a long task with commits"), undefined);
