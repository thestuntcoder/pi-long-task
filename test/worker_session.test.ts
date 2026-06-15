import assert from "node:assert/strict";

import {
  assistantMessageText,
  assistantTextFromEvent,
  buildCompactionInstructions,
  buildShutdownMessage,
  buildTaskPrompt,
  buildTimeLimitMessage,
  lastAssistantTextFromEvents,
  lastAssistantTextFromMessages,
} from "../src/worker_session.ts";

const task = {
  taskId: "4",
  title: "Port worker prompt and TASK_RESULT parsing",
  section: `## TODO 4 — Port worker prompt and TASK_RESULT parsing

**Goal:** Port prompt construction and worker result parsing into TypeScript.

**Status:**
- [ ] Build assigned-task worker prompt`,
};

const prompt = buildTaskPrompt({
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 2,
  commitRequested: true,
  previousAttempts: "Attempt 1 was partial.",
  globalInstructions: "Global guardrail.",
  maxBashTimeoutSeconds: 300,
});

assert.match(prompt, /You are one Pi RPC worker session assigned to exactly one TODO task\./);
assert.match(prompt, /Assigned TODO file path: `\/tmp\/TODO.md`/);
assert.match(prompt, /Assigned task: `TODO 4 — Port worker prompt and TASK_RESULT parsing`/);
assert.match(prompt, /Attempt: 2/);
assert.match(prompt, /The coordinator will commit after your session if needed\. Do not run git commit\./);
assert.match(prompt, /Global instructions from the TODO file apply to this task:/);
assert.match(prompt, /```markdown\nGlobal guardrail\.\n```/);
assert.match(prompt, /Assigned task content only:/);
assert.match(prompt, /Previous attempts for this same assigned task/);
assert.match(prompt, /Do not run bash commands with timeout greater than 300 seconds/);
assert.ok(prompt.endsWith("Only use `status: done` if the assigned task is fully complete and verified as far as practical."));

const noCommitPrompt = buildTaskPrompt({
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 120,
});
assert.match(noCommitPrompt, /Do not run git commit\. The coordinator was started with commits disabled\./);
assert.doesNotMatch(noCommitPrompt, /Previous attempts for this same assigned task/);

assert.equal(
  buildTimeLimitMessage(12.4),
  "Coordinator notice: this worker session has reached its 12s time budget.\nStop after the current safe point. Do not start more implementation work.\nFinish with the required TASK_RESULT block now.\nUse `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.",
);
assert.equal(
  buildShutdownMessage(91.23),
  "Coordinator notice: context usage is 91.2%, above the 85% shutdown threshold.\nStop after the current safe point. Do not start more implementation work.\nLeave files in a safe state and finish with the required TASK_RESULT block.\nUse `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.",
);
assert.equal(
  buildCompactionInstructions(task),
  "Keep only information needed to finish assigned task TODO 4 — Port worker prompt and TASK_RESULT parsing: relevant files inspected,\nedits made, verification run, failures, and remaining steps. Drop unrelated details.",
);

assert.equal(assistantMessageText({ role: "user", content: "ignore" }), "");
assert.equal(assistantMessageText({ role: "assistant", content: "plain text" }), "plain text");
assert.equal(
  assistantMessageText({
    role: "assistant",
    content: [
      { type: "text", text: "hello " },
      { type: "tool_use", text: "ignored" },
      { type: "output_text", text: "world" },
    ],
  }),
  "hello world",
);
assert.equal(
  lastAssistantTextFromMessages([
    { role: "assistant", content: "first" },
    { role: "user", content: "ignored" },
    { role: "assistant", content: [{ type: "text", text: "last" }] },
  ]),
  "last",
);
assert.equal(assistantTextFromEvent({ message: { role: "assistant", content: "event message" } }), "event message");
assert.equal(assistantTextFromEvent({ messages: [{ role: "assistant", content: "event messages" }] }), "event messages");
assert.equal(assistantTextFromEvent({ role: "assistant", content: "direct event" }), "direct event");
assert.equal(
  lastAssistantTextFromEvents([
    { message: { role: "assistant", content: "first event" } },
    { messages: [{ role: "assistant", content: "last event" }] },
  ]),
  "last event",
);
