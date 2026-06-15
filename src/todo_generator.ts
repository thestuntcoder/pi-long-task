import { parseTasks, TodoParseError } from "./todo_parser.ts";

const TODO_HEADING_RE = /^##\s+TODO\s+(\d+)\s+[—-]\s+(.+?)\s*$/gm;
const TODO_HEADING_LINE_RE = /^##\s+TODO\s+(\d+)\s+[—-]\s+(.+?)\s*$/;
const PROGRESS_HEADING_RE = /^##\s+Progress\s*$/im;
const BULLET_ITEM_RE = /^\s*[-*+]\s+(?!-{2,}\s*$)(.+?)\s*$/;
const NUMBERED_ITEM_RE = /^\s*\d+[.)]\s+(.+?)\s*$/;
const FENCE_RE = /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi;

export class TodoGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoGenerationError";
  }
}

interface ExistingTask {
  taskId: string;
  title: string;
  body: string;
}

export function todoMarkdownFromString(rawInput: string): string | undefined {
  const input = rawInput.trim();
  if (!input) {
    return undefined;
  }

  if (hasTodoHeadings(input)) {
    const markdown = normalizeExistingTodoMarkdown(input);
    validateTodoMarkdown(markdown);
    return markdown;
  }

  const listItems = simpleListItems(input);
  if (listItems.length >= 2) {
    const markdown = generatedTodoMarkdown(listItems);
    validateTodoMarkdown(markdown);
    return markdown;
  }

  return undefined;
}

export function generatedTodoMarkdown(items: string[]): string {
  const titles = items.map(cleanTitle).filter((item) => item.length > 0);
  if (titles.length === 0) {
    throw new TodoGenerationError("Cannot generate TODO markdown without at least one task item.");
  }

  const progress = titles.map((title, idx) => `- [ ] TODO ${idx + 1} — ${title}`).join("\n");
  const sections = titles
    .map((title, idx) => {
      const taskId = idx + 1;
      return `## TODO ${taskId} — ${title}\n\n**Goal:** ${goalForTitle(title)}\n\n**Status:**\n- [ ] Complete ${lowercaseFirst(title)}\n\n**Verify:**\n- Run focused checks relevant to this task.\n\n**Done when:**\n- The task is implemented and verified.`;
    })
    .join("\n\n");

  return `# Pi Coordinator TODO\n\n## Progress\n\n${progress}\n\n---\n\n${sections}\n`;
}

export function validateTodoMarkdown(markdown: string): void {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith("# Pi Coordinator TODO")) {
    throw new TodoGenerationError("TODO markdown must start with `# Pi Coordinator TODO`.");
  }
  if (!PROGRESS_HEADING_RE.test(trimmed)) {
    throw new TodoGenerationError("TODO markdown must include a `## Progress` section.");
  }
  if (!/^---\s*$/m.test(trimmed)) {
    throw new TodoGenerationError("TODO markdown must include a `---` separator before task sections.");
  }

  let tasks;
  try {
    tasks = parseTasks(markdown);
  } catch (error) {
    if (error instanceof TodoParseError) {
      throw new TodoGenerationError(error.message);
    }
    throw error;
  }

  if (tasks.length === 0) {
    throw new TodoGenerationError("TODO markdown must include at least one task section.");
  }

  tasks.forEach((task, idx) => {
    const expectedId = String(idx + 1);
    if (task.taskId !== expectedId) {
      throw new TodoGenerationError(`Task IDs must be sequential. Expected TODO ${expectedId}, found TODO ${task.taskId}.`);
    }

    const progressLine = progressLineRegex(task.taskId, task.title);
    if (!progressLine.test(markdown)) {
      throw new TodoGenerationError(`Progress section must include an unchecked line for TODO ${task.taskId}.`);
    }

    if (!/\*\*Goal:\*\*/.test(task.section)) {
      throw new TodoGenerationError(`TODO ${task.taskId} must include \`**Goal:**\`.`);
    }
    if (!/\*\*Status:\*\*/.test(task.section)) {
      throw new TodoGenerationError(`TODO ${task.taskId} must include \`**Status:**\`.`);
    }
    if (task.statusCheckboxes.length === 0) {
      throw new TodoGenerationError(`TODO ${task.taskId} must include status checkboxes.`);
    }
    if (!/\*\*Verify:\*\*/.test(task.section) && !/verification|verify|checks?/i.test(task.section)) {
      throw new TodoGenerationError(`TODO ${task.taskId} must include \`**Verify:**\` or verification guidance.`);
    }
    if (!/\*\*Done when:\*\*/.test(task.section)) {
      throw new TodoGenerationError(`TODO ${task.taskId} must include \`**Done when:**\`.`);
    }
  });
}

export function buildTodoCreationPrompt(rawInput: string): string {
  return `Convert the following raw project request into coordinator-compatible TODO markdown.\n\nRequirements:\n- Output only markdown, with no commentary and no code fence.\n- Start with exactly: # Pi Coordinator TODO\n- Include a ## Progress section with one unchecked line per task: - [ ] TODO N — Title\n- Include a --- separator before task sections.\n- Create sequential sections named ## TODO N — Title.\n- Each task section must include **Goal:**, **Status:** with unchecked checkbox items, **Verify:** with concrete verification guidance, and **Done when:**.\n- Preserve any global instructions or constraints that apply to all tasks above ## Progress.\n- Keep tasks focused and independently assignable to worker sessions.\n\nRaw input:\n\n${rawInput.trim()}\n`;
}

export function extractTodoMarkdown(assistantText: string): string {
  for (const block of fencedMarkdownBlocks(assistantText)) {
    const candidate = normalizeCandidate(block);
    if (candidate) {
      return candidate;
    }
  }

  const headerIndex = assistantText.indexOf("# Pi Coordinator TODO");
  if (headerIndex >= 0) {
    const candidate = normalizeCandidate(assistantText.slice(headerIndex));
    if (candidate) {
      return candidate;
    }
  }

  const todoHeading = assistantText.search(/^##\s+TODO\s+\d+\s+[—-]\s+/m);
  if (todoHeading >= 0) {
    const candidate = normalizeCandidate(assistantText.slice(todoHeading));
    if (candidate) {
      return candidate;
    }
  }

  throw new TodoGenerationError("Could not extract valid coordinator TODO markdown from assistant text.");
}

function normalizeCandidate(candidate: string): string | undefined {
  try {
    const markdown = todoMarkdownFromString(candidate.trim());
    if (markdown) {
      return markdown;
    }
    validateTodoMarkdown(candidate);
    return ensureTrailingNewline(candidate.trim());
  } catch {
    return undefined;
  }
}

function hasTodoHeadings(input: string): boolean {
  TODO_HEADING_RE.lastIndex = 0;
  return TODO_HEADING_RE.test(input);
}

function normalizeExistingTodoMarkdown(input: string): string {
  const tasks = extractExistingTasks(input);
  if (tasks.length === 0) {
    throw new TodoGenerationError("No task headings found to normalize.");
  }

  const globalInstructions = extractGlobalInstructions(input);
  const progress = tasks.map((task, idx) => `- [ ] TODO ${idx + 1} — ${task.title}`).join("\n");
  const sections = tasks
    .map((task, idx) => normalizeTaskSection({ ...task, taskId: String(idx + 1) }))
    .join("\n\n");

  const globalBlock = globalInstructions ? `\n\n${globalInstructions}` : "";
  return `# Pi Coordinator TODO${globalBlock}\n\n## Progress\n\n${progress}\n\n---\n\n${sections}\n`;
}

function extractExistingTasks(input: string): ExistingTask[] {
  TODO_HEADING_RE.lastIndex = 0;
  const matches = [...input.matchAll(TODO_HEADING_RE)];
  return matches.map((match, idx) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = idx + 1 < matches.length ? matches[idx + 1].index ?? input.length : input.length;
    return {
      taskId: match[1],
      title: cleanTitle(match[2]),
      body: input.slice(bodyStart, bodyEnd).trim(),
    };
  });
}

function extractGlobalInstructions(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const selected: string[] = [];

  for (const line of lines) {
    if (TODO_HEADING_LINE_RE.test(line.trim()) || /^##\s+Progress\s*$/i.test(line.trim())) {
      break;
    }
    if (/^#\s+Pi Coordinator TODO\s*$/i.test(line.trim())) {
      continue;
    }
    selected.push(line);
  }

  return selected.join("\n").trim();
}

function normalizeTaskSection(task: ExistingTask): string {
  const body = task.body.trim();
  const blocks: string[] = [];
  if (body) {
    blocks.push(body);
  }

  const sectionProbe = `## TODO ${task.taskId} — ${task.title}\n\n${body}`;
  if (!/\*\*Goal:\*\*/.test(sectionProbe)) {
    blocks.push(`**Goal:** ${goalForTitle(task.title)}`);
  }
  if (!/\*\*Status:\*\*/.test(sectionProbe)) {
    blocks.push(`**Status:**\n- [ ] Complete ${lowercaseFirst(task.title)}`);
  } else if (!/^\s*-\s+\[[ xX]\]\s+/m.test(body)) {
    blocks.push(`- [ ] Complete ${lowercaseFirst(task.title)}`);
  }
  if (!/\*\*Verify:\*\*/.test(sectionProbe) && !/verification|verify|checks?/i.test(sectionProbe)) {
    blocks.push("**Verify:**\n- Run focused checks relevant to this task.");
  }
  if (!/\*\*Done when:\*\*/.test(sectionProbe)) {
    blocks.push("**Done when:**\n- The task is implemented and verified.");
  }

  return `## TODO ${task.taskId} — ${task.title}\n\n${blocks.join("\n\n")}`.trimEnd();
}

function simpleListItems(input: string): string[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const nonBlank = lines.map((line) => line.trim()).filter(Boolean);
  if (nonBlank.length < 2) {
    return [];
  }

  const items: string[] = [];

  for (const line of nonBlank) {
    const bullet = BULLET_ITEM_RE.exec(line);
    if (bullet) {
      items.push(stripCheckboxMarker(bullet[1]));
      continue;
    }

    const numbered = NUMBERED_ITEM_RE.exec(line);
    if (numbered) {
      items.push(stripCheckboxMarker(numbered[1]));
      continue;
    }

    return [];
  }

  return items.map(cleanTitle).filter(Boolean);
}

function stripCheckboxMarker(value: string): string {
  return value.replace(/^\[[ xX]\]\s+/, "");
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.。]\s*$/, "");
}

function goalForTitle(title: string): string {
  return `Complete ${lowercaseFirst(title)}.`;
}

function lowercaseFirst(value: string): string {
  if (!value) {
    return value;
  }
  return `${value[0].toLocaleLowerCase()}${value.slice(1)}`;
}

function progressLineRegex(taskId: string, title: string): RegExp {
  return new RegExp(`^\\s*-\\s+\\[ \\]\\s+TODO\\s+${escapeRegExp(taskId)}\\s+[—-]\\s+${escapeRegExp(title)}\\s*$`, "m");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fencedMarkdownBlocks(text: string): string[] {
  FENCE_RE.lastIndex = 0;
  return [...text.matchAll(FENCE_RE)].map((match) => match[1]);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
