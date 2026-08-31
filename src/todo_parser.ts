export interface TaskStatusItem {
  text: string;
  done: boolean;
}

export interface Task {
  taskId: string;
  title: string;
  /** Optional identity persisted in a task section as `<!-- pi-long-task-id: value -->`. */
  stableId?: string;
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
const FIELD_HEADING_RE = /^\*\*[^*\r\n]+:\*\*\s*$/;
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;
const STABLE_ID_RE = /^\s*<!--\s*pi-long-task-id:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s*-->\s*$/i;

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
  let fence: string | undefined;

  lines.forEach((line, idx) => {
    const stripped = stripLineBreaks(line);
    const fenceMatch = FENCE_LINE_RE.exec(stripped);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (fence) {
      return;
    }

    const match = TASK_HEADING_RE.exec(stripped);
    if (match) {
      headings.push({
        startIdx: idx,
        taskId: match[1],
        title: match[2].trim(),
      });
    }
  });

  return headings;
}

function findStableId(lines: string[], startIdx: number, endIdx: number): string | undefined {
  let fence: string | undefined;
  for (let idx = startIdx; idx < endIdx; idx += 1) {
    const stripped = stripLineBreaks(lines[idx]);
    const fenceMatch = FENCE_LINE_RE.exec(stripped);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (!fence) {
      const match = STABLE_ID_RE.exec(stripped);
      if (match) {
        return match[1];
      }
    }
  }
  return undefined;
}

function findProgressDone(lines: string[], taskId: string): boolean | undefined {
  const regex = progressRegexForTask(taskId);
  const progressStart = lines.findIndex((line) => GLOBAL_PROGRESS_HEADING_RE.test(stripLineBreaks(line).trim()));
  if (progressStart < 0) {
    return undefined;
  }

  for (let idx = progressStart + 1; idx < lines.length; idx += 1) {
    const stripped = stripLineBreaks(lines[idx]);
    if (/^\s*---\s*$/.test(stripped) || TASK_HEADING_RE.test(stripped)) {
      break;
    }
    const match = regex.exec(stripped);
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

    if (FIELD_HEADING_RE.test(stripped) || seenCheckbox) {
      break;
    }
  }

  return items;
}

function setStatusBlockDone(lines: string[], startIdx: number, endIdx: number, done: boolean): void {
  let inStatus = false;
  let seenCheckbox = false;
  const marker = done ? "x" : " ";

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
      if ((checkbox[2].toLowerCase() === "x") !== done) {
        lines[idx] = `${checkbox[1]}${marker}${checkbox[3]}${newline}`;
      }
      continue;
    }

    if (stripped === "") {
      continue;
    }

    if (FIELD_HEADING_RE.test(stripped) || seenCheckbox) {
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
      stableId: findStableId(lines, heading.startIdx, endIdx),
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

function setTaskDone(markdown: string, taskId: string, done: boolean): string {
  const lines = splitLinesKeepEnds(markdown);
  const progressRegex = progressRegexForTask(taskId);
  const marker = done ? "x" : " ";

  lines.forEach((line, idx) => {
    const raw = stripLineBreaks(line);
    const newline = line.endsWith("\n") ? "\n" : "";
    const match = progressRegex.exec(raw);
    if (match && (match[2].toLowerCase() === "x") !== done) {
      lines[idx] = `${match[1]}${marker}${match[3]}${newline}`;
    }
  });

  const headings = parseTaskHeadings(lines);
  const headingPos = headings.findIndex((heading) => heading.taskId === taskId);
  if (headingPos >= 0) {
    const endIdx = headingPos + 1 < headings.length ? headings[headingPos + 1].startIdx : lines.length;
    setStatusBlockDone(lines, headings[headingPos].startIdx, endIdx, done);
  }

  return lines.join("");
}

export function markTaskDone(markdown: string, taskId: string): string {
  return setTaskDone(markdown, taskId, true);
}

/** Clears planner-supplied completion for work whose coordinator-owned state is not complete. */
export function markTaskPending(markdown: string, taskId: string): string {
  return setTaskDone(markdown, taskId, false);
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
