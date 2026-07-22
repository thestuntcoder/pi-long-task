export const DONE_STATUSES = new Set(["done", "complete", "completed", "success", "succeeded"]);
export const PARTIAL_STATUSES = new Set(["partial", "incomplete", "blocked", "failed", "failure", "unknown"]);

const TASK_RESULT_MARKER_RE = /TASK_RESULT\s*:/gi;
const STATUS_LINE_RE = /^\s*status\s*:\s*([A-Za-z_-]+)\s*$/im;
const REQUIRED_LIST_FIELDS = ["changes", "verification", "remaining"] as const;

export interface TaskResultBlock {
  marker: "TASK_RESULT";
  body: string;
  fenced: boolean;
}

export interface ParsedTaskResult {
  status: string;
  summary: string;
  changes: string[];
  verification: string[];
  remaining: string[];
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

export function parseCompleteTaskResult(assistantText: string): ParsedTaskResult | undefined {
  const block = extractTaskResultBlock(assistantText);
  if (!block) {
    return undefined;
  }

  const fields = parseResultFields(block.body);
  const status = fields.scalars.get("status")?.trim().toLowerCase() ?? "";
  const summary = fields.scalars.get("summary")?.trim() ?? "";
  if (!status || !summary || (!isDoneStatus(status) && !isPartialStatus(status))) {
    return undefined;
  }

  const lists = Object.fromEntries(
    REQUIRED_LIST_FIELDS.map((field) => [field, fields.lists.get(field) ?? []]),
  ) as Record<(typeof REQUIRED_LIST_FIELDS)[number], string[]>;
  if (REQUIRED_LIST_FIELDS.some((field) => lists[field].length === 0)) {
    return undefined;
  }

  return { status, summary, ...lists };
}

export function hasCompleteTaskResult(assistantText: string): boolean {
  return parseCompleteTaskResult(assistantText) !== undefined;
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
  TASK_RESULT_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | undefined;
  while ((match = TASK_RESULT_MARKER_RE.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return undefined;
  }

  const markerEnd = lastMatch.index + lastMatch[0].length;
  const fence = enclosingFence(text, lastMatch.index);
  const bodyEnd = fence?.end ?? text.length;
  return {
    marker: "TASK_RESULT",
    body: text.slice(markerEnd, bodyEnd).trim(),
    fenced: Boolean(fence),
  };
}

function enclosingFence(text: string, position: number): { end: number } | undefined {
  const fenceRe = /^(`{3,})[^\r\n`]*\r?\n/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const contentStart = match.index + match[0].length;
    const closeRe = new RegExp(`^${match[1]}\\s*$`, "gm");
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(text);
    if (!close) {
      continue;
    }
    if (position >= contentStart && position < close.index) {
      return { end: close.index };
    }
    fenceRe.lastIndex = close.index + close[0].length;
  }
  return undefined;
}

function parseResultFields(body: string): {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
} {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let currentList: string | undefined;

  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const field = /^\s*([A-Za-z_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (field) {
      const name = field[1].toLowerCase();
      currentList = REQUIRED_LIST_FIELDS.includes(name as (typeof REQUIRED_LIST_FIELDS)[number]) ? name : undefined;
      if (currentList) {
        lists.set(currentList, []);
      } else {
        scalars.set(name, field[2]);
      }
      continue;
    }

    if (currentList) {
      const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
      if (bullet?.[1]) {
        lists.get(currentList)?.push(bullet[1]);
      }
    }
  }
  return { scalars, lists };
}
