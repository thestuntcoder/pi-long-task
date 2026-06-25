import { inferCoverageGoalText } from "./coverage_goal.ts";

const LONG_TASK_RE = /\b(?:long[-\s]?task|longtask|large[-\s]?task|big[-\s]?task|multi[-\s]?step(?:\s+task)?)\b/i;
const DIRECT_LONG_TASK_REQUEST_RE =
  /\b(?:run|start|do|handle|execute|launch|kick\s+off|use)\s+(?:a\s+|the\s+)?(?:long[-\s]?task|longtask|large[-\s]?task|big[-\s]?task|multi[-\s]?step(?:\s+task)?)\b/i;
const WANT_LONG_TASK_RE =
  /\b(?:please|can\s+you|could\s+you|i\s+want|i\s+need|i'd\s+like|i\s+would\s+like|let's|lets)\b[\s\S]*\b(?:long[-\s]?task|longtask|large[-\s]?task|big[-\s]?task|multi[-\s]?step(?:\s+task)?)\b/i;
const NEGATED_LONG_TASK_RE =
  /\b(?:do\s+not|don't|dont|never)\s+(?:run|start|do|handle|execute|launch|kick\s+off|use)\s+(?:a\s+|the\s+)?(?:long[-\s]?task|longtask|large[-\s]?task|big[-\s]?task|multi[-\s]?step(?:\s+task)?)\b/i;
const INFORMATION_QUESTION_RE = /^\s*(?:how|what|why|when|where|who)\b/i;
const EXPLICIT_TOOL_RE = /\b(?:pi_long_task|pi_goal_task)\b/i;
const GOAL_LOOP_RE =
  /\b(?:goal[-\s]?oriented\s+(?:loop|long[-\s]?task|task)|goal\s+(?:loop|task)|iterative\s+long[-\s]?task|repeat\s+until\s+complete|iterate\s+until\s+complete)\b/i;
const DIRECT_GOAL_TASK_REQUEST_RE =
  /\b(?:run|start|do|handle|execute|launch|kick\s+off|use)\s+(?:a\s+|the\s+)?(?:goal[-\s]?oriented\s+(?:loop|long[-\s]?task|task)|goal\s+(?:loop|task)|iterative\s+long[-\s]?task)\b/i;

const COMMIT_FALSE_RE =
  /\b(?:without|no|disable|disabled|off)\s+commits?\b|\bcommits?\s*(?:false|off|disabled)\b|\bcommit\s*:\s*(?:false|off|no)\b|\b(?:do\s+not|don't|dont)\s+commit\b/i;
const COMMIT_TRUE_RE =
  /\bwith\s+commits?\b|\bcommits?\s*(?:true|on|enabled)\b|\bcommit\s*:\s*(?:true|on|yes)\b|\bcommit(?:ting)?\s+as\s+(?:you|we)\s+go\b|\b(?:make|create|include|allow|enable)\s+commits?\b/i;
const GOAL_RE = /\b(?:with\s+(?:the\s+)?goal|goal)\s*(?::|=|\b(?:to|of|for|that)\b)\s*([\s\S]+)$/i;
const TRAILING_COMMIT_MODIFIER_RE =
  /(?:\s+(?:with|without|no|enable|enabled|disable|disabled)\s+commits?|\s+commits?\s*(?:true|false|on|off|enabled|disabled)|\s+commit\s*:\s*(?:true|false|on|off|yes|no))\s*$/i;

export interface ParsedLongTaskRequestOptions {
  commit: boolean;
  goal?: string;
}

export interface ParsedGoalTaskRequestOptions extends ParsedLongTaskRequestOptions {
  maxIterations?: number;
}

export function longTaskInputTransform(text: string): string | undefined {
  const goalLoopPrompt = goalTaskInputTransform(text);
  if (goalLoopPrompt) {
    return goalLoopPrompt;
  }

  if (!isNaturalLanguageLongTaskRequest(text)) {
    return undefined;
  }

  return buildLongTaskToolPrompt(text, parseLongTaskRequestOptions(text));
}

export function goalTaskInputTransform(text: string): string | undefined {
  if (!isNaturalLanguageGoalTaskRequest(text)) {
    return undefined;
  }

  return buildGoalTaskToolPrompt(text, parseGoalTaskRequestOptions(text));
}

export function parseLongTaskRequestOptions(text: string): ParsedLongTaskRequestOptions {
  return {
    commit: inferCommitSetting(text) ?? false,
    goal: inferGoalSetting(text),
  };
}

export function parseGoalTaskRequestOptions(text: string): ParsedGoalTaskRequestOptions {
  return {
    commit: inferCommitSetting(text) ?? true,
    goal: inferGoalSetting(text) ?? inferGoalLoopText(text),
    maxIterations: inferMaxIterations(text),
  };
}

export function isNaturalLanguageLongTaskRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || EXPLICIT_TOOL_RE.test(trimmed)) {
    return false;
  }
  if (!LONG_TASK_RE.test(trimmed) || INFORMATION_QUESTION_RE.test(trimmed) || NEGATED_LONG_TASK_RE.test(trimmed)) {
    return false;
  }
  return DIRECT_LONG_TASK_REQUEST_RE.test(trimmed) || WANT_LONG_TASK_RE.test(trimmed);
}

export function isNaturalLanguageGoalTaskRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || EXPLICIT_TOOL_RE.test(trimmed)) {
    return false;
  }
  if (INFORMATION_QUESTION_RE.test(trimmed) || NEGATED_LONG_TASK_RE.test(trimmed)) {
    return false;
  }
  return (
    GOAL_LOOP_RE.test(trimmed) &&
    (DIRECT_GOAL_TASK_REQUEST_RE.test(trimmed) ||
      DIRECT_LONG_TASK_REQUEST_RE.test(trimmed) ||
      WANT_LONG_TASK_RE.test(trimmed))
  );
}

export function inferCommitSetting(text: string): boolean | undefined {
  if (COMMIT_FALSE_RE.test(text)) {
    return false;
  }
  if (COMMIT_TRUE_RE.test(text)) {
    return true;
  }
  return undefined;
}

export function inferGoalSetting(text: string): string | undefined {
  const match = GOAL_RE.exec(text);
  if (!match?.[1]) {
    return inferCoverageGoalText(text);
  }
  return normalizeGoalText(match[1]);
}

function normalizeGoalText(text: string): string | undefined {
  let goal = text.trim();
  while (TRAILING_COMMIT_MODIFIER_RE.test(goal)) {
    goal = goal.replace(TRAILING_COMMIT_MODIFIER_RE, "").trim();
  }
  goal = goal.replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, "").trim();
  return goal || undefined;
}

function inferMaxIterations(text: string): number | undefined {
  const match = /\bmax(?:imum)?\s+(?:iterations?|loops?|passes?)\s*(?::|=|of|to)?\s*(\d+)\b/i.exec(text);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
}

function inferGoalLoopText(text: string): string | undefined {
  let goal = text.trim();
  goal = goal.replace(
    /^\s*(?:please\s+)?(?:run|start|do|handle|execute|launch|kick\s+off|use)\s+(?:a\s+|the\s+)?/i,
    "",
  );
  goal = goal.replace(GOAL_LOOP_RE, "").trim();
  goal = goal.replace(/^\s*(?:with\s+)?(?:goal|to|for|that)\b\s*/i, "");
  return normalizeGoalText(goal);
}

function buildLongTaskToolPrompt(originalText: string, options: ParsedLongTaskRequestOptions): string {
  const goalLine = options.goal ? [`Set goal to ${JSON.stringify(options.goal)}.`] : [];
  return [
    "Use the pi_long_task tool for this request.",
    `Set commit to ${options.commit ? "true" : "false"}.`,
    ...goalLine,
    "Do not rely on inputText for parsed options; commit and goal are parsed separately. Use the original request as inputText only when the tool call includes inputText.",
    "Do not perform the work directly outside pi_long_task.",
    "",
    "Original request:",
    "```text",
    originalText.trim(),
    "```",
  ].join("\n");
}

function buildGoalTaskToolPrompt(originalText: string, options: ParsedGoalTaskRequestOptions): string {
  const goalLine = options.goal
    ? `Set goal to ${JSON.stringify(options.goal)}.`
    : "Set goal from the original request.";
  const maxIterationsLine = options.maxIterations ? [`Set maxIterations to ${options.maxIterations}.`] : [];
  return [
    "Use the pi_goal_task tool for this request.",
    goalLine,
    `Set commit to ${options.commit ? "true" : "false"}.`,
    ...maxIterationsLine,
    "The goal loop will generate TODO markdown, execute it as a long task, review completion, and repeat until complete or stopped by limits.",
    "Do not perform the work directly outside pi_goal_task.",
    "",
    "Original request:",
    "```text",
    originalText.trim(),
    "```",
  ].join("\n");
}
