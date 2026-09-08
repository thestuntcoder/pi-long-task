import assert from "node:assert/strict";

import {
  applyGoalInstructionsToTodoMarkdown,
  buildTodoCreationPrompt,
  buildTodoRepairPrompt,
  extractAndValidateTodoMarkdown,
  extractTodoMarkdown,
  generatedTodoMarkdown,
  todoMarkdownFromString,
  validateTodoMarkdown,
} from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";

const existing = `# Some source plan

Global constraint.

## TODO 7 - Wire long-task runner

Keep this note.

**Status:**
- [ ] Add integration
`;

const normalized = todoMarkdownFromString(existing);
assert.ok(normalized);
assert.ok(normalized.startsWith("# Pi Long Task TODO\n\n# Some source plan\n\nGlobal constraint."));
assert.match(normalized, /## Progress\n\n- \[ \] TODO 1 — Wire long-task runner/);
assert.match(normalized, /## TODO 1 — Wire long-task runner/);
assert.match(normalized, /Keep this note/);
assert.match(normalized, /\*\*Goal:\*\*/);
assert.match(normalized, /\*\*Verify:\*\*/);
assert.match(normalized, /\*\*Done when:\*\*/);
validateTodoMarkdown(normalized);
assert.deepEqual(
  parseTasks(normalized).map((task) => [task.taskId, task.title]),
  [["1", "Wire long-task runner"]],
);

const bulletMarkdown = todoMarkdownFromString(`- Add native parser
- Implement worker runner
- Update docs.`);
assert.ok(bulletMarkdown);
validateTodoMarkdown(bulletMarkdown);
assert.deepEqual(
  parseTasks(bulletMarkdown).map((task) => task.title),
  ["Add native parser", "Implement worker runner", "Update docs"],
);
assert.match(bulletMarkdown, /- \[ \] TODO 3 — Update docs/);

const numberedMarkdown = todoMarkdownFromString(`1. Read inputs
2) Generate TODO markdown`);
assert.ok(numberedMarkdown);
validateTodoMarkdown(numberedMarkdown);
assert.deepEqual(
  parseTasks(numberedMarkdown).map((task) => task.title),
  ["Read inputs", "Generate TODO markdown"],
);
assert.match(numberedMarkdown, /\*\*Status:\*\*\n- \[ \] Complete read inputs/);

const rawParagraph =
  "Build a long-task runner that can split a broad request into safe worker tasks and report progress.";
assert.equal(todoMarkdownFromString(rawParagraph), undefined);
const prompt = buildTodoCreationPrompt(rawParagraph);
assert.match(prompt, /Convert the following raw project request/);
assert.match(prompt, /# Pi Long Task TODO/);
assert.match(prompt, /## Progress/);
assert.match(prompt, /\*\*Goal:\*\*/);
assert.match(prompt, /\*\*Status:\*\*/);
assert.match(prompt, /\*\*Verify:\*\*/);
assert.match(prompt, /\*\*Done when:\*\*/);
assert.match(prompt, /Build a long-task runner/);
assert.match(prompt, /Produce only a concise executable plan for future workers\./);
assert.match(prompt, /do not implement or write code, execute research or report findings/i);
assert.match(prompt, /create requested creative output \(prose, stories, copy, designs, or assets\)/i);
assert.match(prompt, /Keep repeated task sections compact/);
assert.match(prompt, /Omit rationale, lengthy analysis, summaries, duplicated context/);
assert.match(prompt, /Preserve every instruction, constraint, required deliverable, and acceptance condition/);
assert.doesNotMatch(prompt, /Overall goal:/);

const promptWithGoal = buildTodoCreationPrompt(rawParagraph, "Deliver a production-ready long-task runner.");
assert.match(promptWithGoal, /Overall goal:\n\nDeliver a production-ready long-task runner\./);
assert.match(promptWithGoal, /Raw input:\n\nBuild a long-task runner/);

const promptWithCoverageGoal = buildTodoCreationPrompt(rawParagraph, "have testing line coverage above 80%");
assert.match(promptWithCoverageGoal, /Coverage goal requirements:/);
assert.match(promptWithCoverageGoal, /Raise or maintain testing line coverage above 80%\./);
assert.match(promptWithCoverageGoal, /confirm line coverage is above 80%/);

const representativeRequest = `Create separate tasks for the API, an authentication-options research pass, and launch-story drafting.
Use Node 22, keep all network calls mocked, and preserve the requested task order.`;
const representativeCreationPrompt = buildTodoCreationPrompt(representativeRequest);
assert.match(representativeCreationPrompt, /Use Node 22, keep all network calls mocked/);
assert.match(representativeCreationPrompt, /preserve the requested task order/);

const repairPrompt = buildTodoRepairPrompt(
  representativeRequest,
  "I implemented the API and found that OAuth is best.",
  "Could not extract valid Pi Long Task TODO markdown.",
  "Ship all requested deliverables without changing the public API.",
);
assert.match(repairPrompt, /Correct its plan and format only; do not continue or perform any attempted end work\./);
assert.match(repairPrompt, /Produce only a concise executable plan for future workers\./);
assert.match(repairPrompt, /do not implement or write code, execute research or report findings/i);
assert.match(repairPrompt, /create requested creative output \(prose, stories, copy, designs, or assets\)/i);
assert.match(repairPrompt, /Keep repeated task sections compact/);
assert.match(repairPrompt, /Preserve every instruction, constraint, required deliverable, and acceptance condition/);
assert.match(repairPrompt, /Use Node 22, keep all network calls mocked/);
assert.match(repairPrompt, /Overall goal:\n\nShip all requested deliverables without changing the public API\./);
assert.match(repairPrompt, /I implemented the API and found that OAuth is best\./);

const representativePlannerOutput = `# Pi Long Task TODO

Global instructions:
- Use Node 22.
- Keep all network calls mocked.
- Preserve the requested task order.

## Progress

- [ ] TODO 1 — Implement API
- [ ] TODO 2 — Research authentication options
- [ ] TODO 3 — Draft launch story

---

## TODO 1 — Implement API

**Goal:** Implement the requested API on Node 22.

**Status:**
- [ ] Add the endpoint and focused tests with mocked network calls.

**Verify:**
- Run the focused API tests.

**Done when:** The endpoint works and its tests pass.

## TODO 2 — Research authentication options

**Goal:** Research the requested authentication options without making implementation changes.

**Status:**
- [ ] Compare the relevant options against the request's criteria.

**Verify:**
- Check that the comparison cites its sources and covers every criterion.

**Done when:** The requested comparison is documented and reviewable.

## TODO 3 — Draft launch story

**Goal:** Draft the requested launch story after the technical tasks.

**Status:**
- [ ] Write and review the story against the requested audience and tone.

**Verify:**
- Check the draft against the stated content requirements.

**Done when:** The launch story satisfies the request and is ready for review.
`;
const representativeTodo = extractAndValidateTodoMarkdown(representativePlannerOutput);
const representativeTasks = parseTasks(representativeTodo);
assert.equal(representativeTasks.length, 3);
assert.deepEqual(
  representativeTasks.map((task) => task.title),
  ["Implement API", "Research authentication options", "Draft launch story"],
);
for (const task of representativeTasks) {
  assert.equal(task.done, false, `${task.title} must remain future work`);
  assert.equal(task.statusItems.length, 1, `${task.title} should keep its repetitive status section compact`);
  assert.ok(
    task.statusItems.every((item) => !item.done),
    `${task.title} must not claim completed work`,
  );
  assert.match(task.section, /\*\*Goal:\*\*/);
  assert.match(task.section, /\*\*Verify:\*\*/);
  assert.match(task.section, /\*\*Done when:\*\*/);
}
assert.match(representativeTodo, /Use Node 22\./);
assert.match(representativeTodo, /Keep all network calls mocked\./);
assert.doesNotMatch(representativeTodo, /```|Research findings:|function\s+\w+|Once upon a time/);

const generatedWithCoverageGoal = applyGoalInstructionsToTodoMarkdown(
  generatedTodoMarkdown(["Add parser tests", "Document coverage workflow"]),
  "have testing line coverage above 80%",
);
assert.match(generatedWithCoverageGoal, /- Long task goal: have testing line coverage above 80%/);
assert.match(generatedWithCoverageGoal, /- Coverage goal: Raise or maintain testing line coverage above 80%\./);
assert.equal((generatedWithCoverageGoal.match(/confirm line coverage is above 80%/g) ?? []).length, 3);
validateTodoMarkdown(generatedWithCoverageGoal);

const generated = generatedTodoMarkdown(["First task", "Second task"]);
assert.equal(extractTodoMarkdown(`Here is the plan:\n\n\`\`\`markdown\n${generated}\`\`\``), generated);

const resumed = generated
  .replace("- [ ] TODO 1 — First task", "- [x] TODO 1 — First task")
  .replace("- [ ] Complete first task", "- [x] Complete first task");
const normalizedResume = todoMarkdownFromString(resumed);
assert.ok(normalizedResume);
assert.deepEqual(
  parseTasks(normalizedResume).map((task) => task.done),
  [true, false],
);
validateTodoMarkdown(normalizedResume);

const emptyStatus = generatedTodoMarkdown(["Empty status"]).replace(
  "**Status:**\n- [ ] Complete empty status",
  "**Status:**\n\n**Verify:**\n- [ ] This verification checkbox must not become status\n\n**Verify:**",
);
assert.throws(() => validateTodoMarkdown(emptyStatus), /must include status checkboxes/);

const misplacedProgress = generated
  .replace("- [ ] TODO 1 — First task\n", "")
  .replace("**Verify:**", "**Verify:**\n- [ ] TODO 1 — First task");
assert.throws(() => validateTodoMarkdown(misplacedProgress), /exactly one line for every task/);
