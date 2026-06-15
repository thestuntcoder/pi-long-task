import assert from "node:assert/strict";

import {
  extractResultSummary,
  hasTaskResult,
  hasTaskResultStatus,
  isDoneStatus,
  isPartialStatus,
  parseReportedStatus,
} from "../src/result_writer.ts";

const plain = `Implementation complete.

TASK_RESULT:
status: done
summary: Ported result parsing.
changes:
- Added parser helpers
verification:
- node tests passed
remaining:
- none`;

assert.equal(hasTaskResult(plain), true);
assert.equal(hasTaskResultStatus(plain), true);
assert.equal(parseReportedStatus(plain), "done");
assert.equal(
  extractResultSummary(plain),
  `TASK_RESULT:
status: done
summary: Ported result parsing.
changes:
- Added parser helpers
verification:
- node tests passed
remaining:
- none`,
);

const fenced = `Here is the final report:

\`\`\`text
TASK_RESULT:
status: completed
summary: Finished inside a fence.
changes:
- Added helpers
verification:
- focused tests passed
remaining:
- none
\`\`\`
`;

assert.equal(hasTaskResult(fenced), true);
assert.equal(hasTaskResultStatus(fenced), true);
assert.equal(parseReportedStatus(fenced), "completed");
assert.equal(
  extractResultSummary(fenced),
  `TASK_RESULT:
status: completed
summary: Finished inside a fence.
changes:
- Added helpers
verification:
- focused tests passed
remaining:
- none`,
);

const missingStatus = `TASK_RESULT:
summary: Missing status.`;
assert.equal(hasTaskResult(missingStatus), true);
assert.equal(hasTaskResultStatus(missingStatus), false);
assert.equal(parseReportedStatus(missingStatus), "unknown");

const blocked = `TASK_RESULT:
status: blocked
summary: Out of scope.`;
assert.equal(parseReportedStatus(blocked), "blocked");
assert.equal(isDoneStatus("success"), true);
assert.equal(isDoneStatus("succeeded"), true);
assert.equal(isPartialStatus("failure"), true);
assert.equal(isPartialStatus("unknown"), true);

assert.equal(extractResultSummary(`${plain}\nextra text`, 20), "TASK_RESULT:\nstatus:\n\n[truncated by coordinator]\n");
