export const DONE_STATUSES = new Set(["done", "complete", "completed", "success", "succeeded"]);
export const PARTIAL_STATUSES = new Set(["partial", "incomplete", "blocked", "failed", "failure", "unknown"]);

const TASK_RESULT_MARKER_RE = /TASK_RESULT\s*:/gi;
const STATUS_LINE_RE = /^\s*status\s*:\s*([A-Za-z_-]+)\s*$/im;
const FENCED_BLOCK_RE = /```[^\r\n`]*\r?\n([\s\S]*?)\r?\n```/g;

export interface TaskResultBlock {
  marker: "TASK_RESULT";
  body: string;
  fenced: boolean;
}

export function isDoneStatus(status: string): boolean {
  return DONE_STATUSES.has(status.trim().toLowerCase());
}

export function isPartialStatus(status: string): boolean {
  return PARTIAL_STATUSES.has(status.trim().toLowerCase());
}

export function hasTaskResult(assistantText: string): boolean {
  return /TASK_RESULT\s*:/i.test(assistantText || "");
}

export function hasTaskResultStatus(assistantText: string): boolean {
  const block = extractTaskResultBlock(assistantText);
  return Boolean(block && STATUS_LINE_RE.test(block.body));
}

export function parseReportedStatus(assistantText: string): string {
  const block = extractTaskResultBlock(assistantText);
  const searchText = block ? block.body : assistantText || "";
  const match = STATUS_LINE_RE.exec(searchText);
  if (!match) {
    return "unknown";
  }

  return match[1].trim().toLowerCase();
}

export function extractResultSummary(assistantText: string, limit = 8000): string {
  let text = (assistantText || "").trim();
  const block = extractTaskResultBlock(text);
  if (block) {
    text = `TASK_RESULT:\n${block.body.trim()}`;
  }

  if (text.length > limit) {
    return `${text.slice(0, limit)}\n\n[truncated by Pi Long Task]\n`;
  }
  return text;
}

export const summarizeAssistantResult = extractResultSummary;

export function extractTaskResultBlock(assistantText: string): TaskResultBlock | undefined {
  const text = assistantText || "";
  const fencedBlocks = fencedCodeBlocks(text);
  for (let idx = fencedBlocks.length - 1; idx >= 0; idx -= 1) {
    const body = taskResultBodyFromText(fencedBlocks[idx]);
    if (body !== undefined) {
      return { marker: "TASK_RESULT", body, fenced: true };
    }
  }

  const body = taskResultBodyFromText(text);
  if (body === undefined) {
    return undefined;
  }
  return { marker: "TASK_RESULT", body: stripTrailingFence(body), fenced: false };
}

function taskResultBodyFromText(text: string): string | undefined {
  TASK_RESULT_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | undefined;
  while ((match = TASK_RESULT_MARKER_RE.exec(text)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return undefined;
  }

  return text.slice(lastMatch.index + lastMatch[0].length).trim();
}

function fencedCodeBlocks(text: string): string[] {
  FENCED_BLOCK_RE.lastIndex = 0;
  return [...text.matchAll(FENCED_BLOCK_RE)].map((match) => match[1]);
}

function stripTrailingFence(text: string): string {
  return text.replace(/\r?\n```\s*$/g, "").trim();
}
