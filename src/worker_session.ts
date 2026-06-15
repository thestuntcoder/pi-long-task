import type { Task } from "./todo_parser.ts";

export interface WorkerTaskPromptOptions {
  todoPath: string;
  task: Pick<Task, "taskId" | "title" | "section">;
  attempt: number;
  commitRequested: boolean;
  previousAttempts?: string;
  globalInstructions?: string;
  maxBashTimeoutSeconds: number;
}

export interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
}

export function taskLabel(task: Pick<Task, "taskId" | "title">): string {
  return `TODO ${task.taskId} — ${task.title}`;
}

export function buildTaskPrompt(options: WorkerTaskPromptOptions): string {
  const commitText = options.commitRequested
    ? "The coordinator will commit after your session if needed. Do not run git commit."
    : "Do not run git commit. The coordinator was started with commits disabled.";

  const previousAttempts = (options.previousAttempts || "").trim();
  const previousText = previousAttempts
    ? `
Previous attempts for this same assigned task are below. Use them only as continuity for this task:

\`\`\`text
${previousAttempts}
\`\`\`
`
    : "";

  const globalInstructions = (options.globalInstructions || "").trim();
  const globalText = globalInstructions
    ? `
Global instructions from the TODO file apply to this task:

\`\`\`markdown
${globalInstructions}
\`\`\`
`
    : "";

  return `You are one Pi RPC worker session assigned to exactly one TODO task.

Assigned TODO file path: \`${options.todoPath}\`
Assigned task: \`${taskLabel(options.task)}\`
Attempt: ${options.attempt}

Rules:
- Work only on the assigned task below. Do not start or fix other TODO tasks.
- The coordinator is responsible for marking TODO progress. Do not edit \`${options.todoPath}\` unless it is directly necessary for the assigned task implementation itself.
- Do not edit \`TASK_RESULT.md\`; the coordinator writes it.
- ${commitText}
- If you need to stop because context is high or the work is blocked, leave the repository in a safe state and report \`status: partial\` or \`status: blocked\`.
- Use the repository's AGENTS.md/project instructions.
- Run focused verification commands when practical.
- Do not run bash commands with timeout greater than ${options.maxBashTimeoutSeconds.toFixed(0)} seconds. For long full-suite checks, run once with a bounded timeout and report any timeout/failure in TASK_RESULT instead of continuing indefinitely.
- If TODO-file global instructions restrict scope, obey them strictly. If the task appears to require out-of-scope code changes, stop and report \`status: blocked\` instead of changing those files.

${globalText}Assigned task content only:

\`\`\`markdown
${options.task.section.trimEnd()}
\`\`\`
${previousText}
When you are finished, your final assistant message must end with this machine-readable block:

TASK_RESULT:
status: done|partial|blocked|failed
summary: <short summary>
changes:
- <changed item or "none">
verification:
- <command/result or "not run">
remaining:
- <remaining item or "none">

Only use \`status: done\` if the assigned task is fully complete and verified as far as practical.`.trim();
}

export const buildAssignedTaskPrompt = buildTaskPrompt;

export function buildTimeLimitMessage(seconds: number): string {
  return `Coordinator notice: this worker session has reached its ${seconds.toFixed(0)}s time budget.
Stop after the current safe point. Do not start more implementation work.
Finish with the required TASK_RESULT block now.
Use \`status: done\` only if the assigned task is actually complete; otherwise use \`status: partial\`.`;
}

export function buildShutdownMessage(percent: number): string {
  return `Coordinator notice: context usage is ${percent.toFixed(1)}%, above the 85% shutdown threshold.
Stop after the current safe point. Do not start more implementation work.
Leave files in a safe state and finish with the required TASK_RESULT block.
Use \`status: done\` only if the assigned task is actually complete; otherwise use \`status: partial\`.`;
}

export function buildCompactionInstructions(task: Pick<Task, "taskId" | "title">): string {
  return `Keep only information needed to finish assigned task ${taskLabel(task)}: relevant files inspected,
edits made, verification run, failures, and remaining steps. Drop unrelated details.`;
}

export function assistantMessageText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }

  const { content } = message;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    const text = textFromContentPart(item);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("");
}

export function lastAssistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const text = assistantMessageText(messages[idx]);
    if (text) {
      return text;
    }
  }
  return "";
}

export function assistantTextFromEvent(event: unknown): string {
  if (!isRecord(event)) {
    return "";
  }

  const fromMessages = lastAssistantTextFromMessages(event.messages);
  if (fromMessages) {
    return fromMessages;
  }

  const fromMessage = assistantMessageText(event.message);
  if (fromMessage) {
    return fromMessage;
  }

  const fromDelta = textFromDeltaEvent(event);
  if (fromDelta) {
    return fromDelta;
  }

  return assistantMessageText(event);
}

export function lastAssistantTextFromEvents(events: unknown): string {
  if (!Array.isArray(events)) {
    return "";
  }

  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const text = assistantTextFromEvent(events[idx]);
    if (text) {
      return text;
    }
  }
  return "";
}

export const extractAssistantTextFromMessage = assistantMessageText;
export const extractLastAssistantTextFromMessages = lastAssistantTextFromMessages;
export const extractAssistantTextFromEvent = assistantTextFromEvent;
export const extractLastAssistantTextFromEvents = lastAssistantTextFromEvents;

function textFromContentPart(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }

  const type = typeof item.type === "string" ? item.type : "";
  if (type && type !== "text" && type !== "output_text") {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text;
  }
  if (isRecord(item.text) && typeof item.text.value === "string") {
    return item.text.value;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return "";
}

function textFromDeltaEvent(event: Record<string, unknown>): string {
  if (typeof event.text === "string") {
    return event.text;
  }
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (isRecord(event.delta)) {
    return textFromContentPart(event.delta);
  }
  if (isRecord(event.content)) {
    return textFromContentPart(event.content);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
