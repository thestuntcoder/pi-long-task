export interface TaskStatusItem {
  text: string;
  done: boolean;
}

export interface Task {
  taskId: string;
  title: string;
  section: string;
  startLine: number;
  endLine: number;
  done: boolean;
  progressDone?: boolean;
  statusCheckboxes: boolean[];
  statusItems: TaskStatusItem[];
}

export class TodoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoParseError";
  }
}

const TASK_HEADING_RE = /^##\s+TODO\s+(\d+)\s+[—-]\s+(.+?)\s*$/;
const CHECKBOX_RE = /^(\s*-\s+\[)([ xX])(\].*)$/;
const GLOBAL_PROGRESS_HEADING_RE = /^##\s+Progress\s*$/i;

function progressRegexForTask(taskId: string): RegExp {
  return new RegExp(`^(\\s*-\\s+\\[)([ xX])(\\]\\s+TODO\\s+${escapeRegExp(taskId)}\\b.*)$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitLinesKeepEnds(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) ?? [];
}

function splitLines(text: string): string[] {
  return splitLinesKeepEnds(text).map((line) => line.replace(/[\r\n]+$/g, ""));
}

function stripLineBreaks(line: string): string {
  return line.replace(/[\r\n]+$/g, "");
}

interface TaskHeading {
  startIdx: number;
  taskId: string;
  title: string;
}

function parseTaskHeadings(lines: string[]): TaskHeading[] {
  const headings: TaskHeading[] = [];

  lines.forEach((line, idx) => {
    const match = TASK_HEADING_RE.exec(stripLineBreaks(line));
    if (!match) {
      return;
    }

    headings.push({
      startIdx: idx,
      taskId: match[1],
      title: match[2].trim(),
    });
  });

  return headings;
}

function findProgressDone(lines: string[], taskId: string): boolean | undefined {
  const regex = progressRegexForTask(taskId);

  for (const line of lines) {
    const match = regex.exec(stripLineBreaks(line));
    if (match) {
      return match[2].toLowerCase() === "x";
    }
  }

  return undefined;
}

function findStatusItems(lines: string[], startIdx: number, endIdx: number): TaskStatusItem[] {
  let inStatus = false;
  let seenCheckbox = false;
  const items: TaskStatusItem[] = [];

  for (let idx = startIdx; idx < endIdx; idx += 1) {
    const stripped = lines[idx].trim();
    if (stripped === "**Status:**") {
      inStatus = true;
      continue;
    }

    if (!inStatus) {
      continue;
    }

    const checkbox = CHECKBOX_RE.exec(stripLineBreaks(lines[idx]));
    if (checkbox) {
      seenCheckbox = true;
      items.push({
        text: checkbox[3].replace(/^\]\s*/, "").trim(),
        done: checkbox[2].toLowerCase() === "x",
      });
      continue;
    }

    if (stripped === "") {
      continue;
    }

    if (seenCheckbox) {
      break;
    }
  }

  return items;
}

function markStatusBlockDone(lines: string[], startIdx: number, endIdx: number): void {
  let inStatus = false;
  let seenCheckbox = false;

  for (let idx = startIdx; idx < endIdx; idx += 1) {
    const stripped = lines[idx].trim();
    if (stripped === "**Status:**") {
      inStatus = true;
      continue;
    }

    if (!inStatus) {
      continue;
    }

    const raw = stripLineBreaks(lines[idx]);
    const newline = lines[idx].endsWith("\n") ? "\n" : "";
    const checkbox = CHECKBOX_RE.exec(raw);
    if (checkbox) {
      seenCheckbox = true;
      if (checkbox[2].toLowerCase() !== "x") {
        lines[idx] = `${checkbox[1]}x${checkbox[3]}${newline}`;
      }
      continue;
    }

    if (stripped === "") {
      continue;
    }

    if (seenCheckbox) {
      break;
    }
  }
}

export function parseTasks(markdown: string): Task[] {
  const lines = splitLinesKeepEnds(markdown);
  const headings = parseTaskHeadings(lines);

  if (headings.length === 0) {
    throw new TodoParseError("No task sections found. Expected headings like `## TODO 1 — Task title`.");
  }

  return headings.map((heading, pos) => {
    const endIdx = pos + 1 < headings.length ? headings[pos + 1].startIdx : lines.length;
    const section = `${lines.slice(heading.startIdx, endIdx).join("").trimEnd()}\n`;
    const progressDone = findProgressDone(lines, heading.taskId);
    const statusItems = findStatusItems(lines, heading.startIdx, endIdx);
    const statusCheckboxes = statusItems.map((item) => item.done);
    const done = progressDone ?? (statusCheckboxes.length > 0 ? statusCheckboxes.every(Boolean) : false);

    const task: Task = {
      taskId: heading.taskId,
      title: heading.title,
      section,
      startLine: heading.startIdx + 1,
      endLine: endIdx,
      done,
      statusCheckboxes,
      statusItems,
    };
    if (progressDone !== undefined) {
      task.progressDone = progressDone;
    }
    return task;
  });
}

export function incompleteTasks(markdown: string): Task[] {
  return parseTasks(markdown).filter((task) => !task.done);
}

export function markTaskDone(markdown: string, taskId: string): string {
  const lines = splitLinesKeepEnds(markdown);
  const progressRegex = progressRegexForTask(taskId);

  lines.forEach((line, idx) => {
    const raw = stripLineBreaks(line);
    const newline = line.endsWith("\n") ? "\n" : "";
    const match = progressRegex.exec(raw);
    if (match && match[2].toLowerCase() !== "x") {
      lines[idx] = `${match[1]}x${match[3]}${newline}`;
    }
  });

  const headings = parseTaskHeadings(lines);
  const headingPos = headings.findIndex((heading) => heading.taskId === taskId);
  if (headingPos >= 0) {
    const endIdx = headingPos + 1 < headings.length ? headings[headingPos + 1].startIdx : lines.length;
    markStatusBlockDone(lines, headings[headingPos].startIdx, endIdx);
  }

  return lines.join("");
}

export function todoGlobalInstructions(markdown: string, limit = 6000): string {
  const selected: string[] = [];

  for (const line of splitLines(markdown)) {
    const stripped = line.trim();
    if (GLOBAL_PROGRESS_HEADING_RE.test(stripped)) {
      break;
    }
    if (TASK_HEADING_RE.test(stripped)) {
      break;
    }
    selected.push(line);
  }

  let text = selected.join("\n").trim();
  if (text.length > limit) {
    text = `${text.slice(0, limit).trimEnd()}\n\n[truncated by Pi Long Task]`;
  }
  return text;
}
