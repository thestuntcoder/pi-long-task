import assert from "node:assert/strict";

import {
  buildTodoCreationPrompt,
  extractTodoMarkdown,
  generatedTodoMarkdown,
  todoMarkdownFromString,
  validateTodoMarkdown,
} from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";

const existing = `# Some source plan

Global constraint.

## TODO 7 - Wire coordinator

Keep this note.

**Status:**
- [ ] Add integration
`;

const normalized = todoMarkdownFromString(existing);
assert.ok(normalized);
assert.ok(normalized.startsWith("# Pi Coordinator TODO\n\n# Some source plan\n\nGlobal constraint."));
assert.match(normalized, /## Progress\n\n- \[ \] TODO 1 — Wire coordinator/);
assert.match(normalized, /## TODO 1 — Wire coordinator/);
assert.match(normalized, /Keep this note/);
assert.match(normalized, /\*\*Goal:\*\*/);
assert.match(normalized, /\*\*Verify:\*\*/);
assert.match(normalized, /\*\*Done when:\*\*/);
validateTodoMarkdown(normalized);
assert.deepEqual(
  parseTasks(normalized).map((task) => [task.taskId, task.title]),
  [["1", "Wire coordinator"]],
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
  "Build a native coordinator that can split a broad request into safe worker tasks and report progress.";
assert.equal(todoMarkdownFromString(rawParagraph), undefined);
const prompt = buildTodoCreationPrompt(rawParagraph);
assert.match(prompt, /Convert the following raw project request/);
assert.match(prompt, /# Pi Coordinator TODO/);
assert.match(prompt, /## Progress/);
assert.match(prompt, /\*\*Goal:\*\*/);
assert.match(prompt, /\*\*Status:\*\*/);
assert.match(prompt, /\*\*Verify:\*\*/);
assert.match(prompt, /\*\*Done when:\*\*/);
assert.match(prompt, /Build a native coordinator/);

const generated = generatedTodoMarkdown(["First task", "Second task"]);
assert.equal(extractTodoMarkdown(`Here is the plan:\n\n\`\`\`markdown\n${generated}\`\`\``), generated);
