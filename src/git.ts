import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

import type { SessionOutcome } from "./worker_session.ts";

const execFileAsync = promisify(execFile);

const GENERATED_TODO_COMMIT_PREFIX_RE = /^(?:Complete|Progress)\s+TODO\s+\d+(?:\s+[—-]\s*)?/i;
const TODO_LABEL_PREFIX_RE = /^TODO\s+\d+(?:\s+[—-]\s*)?/i;
const CONVENTIONAL_SUBJECT_RE = /^([a-z][a-z0-9-]*)(\([^)]*\))?(!)?:\s+(.+)$/;
const DEFAULT_COMMIT_SUBJECT = "Update project files";
const RECENT_COMMIT_SUBJECT_LIMIT = 20;

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommitAfterSessionOptions {
  cwd: string;
  resultPath: string;
  todoPath?: string;
  runDir?: string;
  outcome: Pick<SessionOutcome, "task" | "reportedStatus" | "done" | "error" | "timedOut" | "aborted">;
  preExistingDirtyPaths?: ReadonlySet<string> | readonly string[];
}

export interface CommitAfterSessionResult {
  hash?: string;
  error?: string;
  skipped?: string;
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    return undefined;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : undefined;
}

export async function gitDirtyPaths(cwd: string, ...excludePaths: string[]): Promise<Set<string>> {
  const root = await gitRoot(cwd);
  if (!root) {
    return new Set();
  }

  const excluded = excludePaths.map((item) => relToRoot(item, root)).filter(Boolean);
  const result = await runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (result.code !== 0) {
    return new Set();
  }

  const dirty = new Set<string>();
  const entries = result.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    const status = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    if (firstPath && !isExcluded(firstPath, excluded)) {
      dirty.add(firstPath);
    }
    if (isRenameOrCopy && index + 1 < entries.length) {
      const secondPath = entries[index + 1];
      index += 1;
      if (secondPath && !isExcluded(secondPath, excluded)) {
        dirty.add(secondPath);
      }
    }
  }
  return dirty;
}

export async function unstagePaths(root: string, paths: Iterable<string>): Promise<void> {
  const pathList = [...new Set([...paths].filter(Boolean))].sort();
  if (pathList.length === 0) {
    return;
  }

  await runGit(root, ["restore", "--staged", "--", ...pathList]);
  await runGit(root, ["reset", "--", ...pathList]);
}

export function shouldCommitOutcome(
  outcome: Pick<SessionOutcome, "reportedStatus" | "error" | "timedOut" | "aborted">,
): boolean {
  if (outcome.error || outcome.timedOut || outcome.aborted) {
    return false;
  }
  const status = outcome.reportedStatus.toLowerCase();
  return ["done", "complete", "completed", "success", "succeeded", "partial", "blocked"].includes(status);
}

export async function commitAfterSession(options: CommitAfterSessionOptions): Promise<CommitAfterSessionResult> {
  if (!shouldCommitOutcome(options.outcome)) {
    return { skipped: "outcome is not eligible for commit" };
  }

  const root = await gitRoot(options.cwd);
  if (!root) {
    return { error: "not inside a git repository" };
  }

  const commitMessage = await commitMessageForOutcome(root, options.outcome);

  try {
    const add = await runGit(root, ["add", "-A"]);
    if (add.code !== 0) {
      return { error: gitError(add) };
    }

    const excludedPaths = new Set<string>();
    addPathIfPresent(excludedPaths, relToRoot(options.resultPath, root));
    if (options.todoPath) {
      addPathIfPresent(excludedPaths, relToRoot(options.todoPath, root));
    }
    if (options.runDir) {
      addPathIfPresent(excludedPaths, relToRoot(options.runDir, root));
    }
    for (const item of options.preExistingDirtyPaths ?? []) {
      addPathIfPresent(excludedPaths, item);
    }

    for (const item of await stagedArtifactPaths(root, options.runDir)) {
      excludedPaths.add(item);
    }

    await unstagePaths(root, excludedPaths);

    const diff = await runGit(root, ["diff", "--cached", "--quiet", "--exit-code"]);
    if (diff.code === 0) {
      return { skipped: "no staged diff" };
    }
    if (diff.code !== 1) {
      return { error: gitError(diff) };
    }

    const commit = await runGit(root, ["commit", "-m", commitMessage]);
    if (commit.code !== 0) {
      return { error: gitError(commit) };
    }

    const rev = await runGit(root, ["rev-parse", "--short", "HEAD"]);
    if (rev.code !== 0) {
      return { error: gitError(rev) };
    }
    return { hash: rev.stdout.trim() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function commitMessageForOutcome(
  root: string,
  outcome: Pick<SessionOutcome, "task" | "reportedStatus" | "done" | "error" | "timedOut" | "aborted">,
): Promise<string> {
  const subject = normalizedTaskSubject(outcome.task.title);
  const recentSubjects = await recentCommitSubjects(root);
  return formatSubjectLikeRecentCommits(subject, recentSubjects);
}

async function recentCommitSubjects(root: string): Promise<string[]> {
  const result = await runGit(root, ["log", `-${RECENT_COMMIT_SUBJECT_LIMIT}`, "--format=%s"]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/g)
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => !GENERATED_TODO_COMMIT_PREFIX_RE.test(subject))
    .filter((subject) => !/^Merge\b/.test(subject) && !/^Revert\b/.test(subject));
}

function formatSubjectLikeRecentCommits(subject: string, recentSubjects: readonly string[]): string {
  const sample = recentSubjects[0];
  if (!sample) {
    return ensureSafeCommitSubject(subject);
  }

  const conventional = CONVENTIONAL_SUBJECT_RE.exec(sample);
  if (conventional) {
    const prefix = `${conventional[1]}${conventional[2] ?? ""}${conventional[3] ?? ""}: `;
    return ensureSafeCommitSubject(`${prefix}${formatSubjectBody(subject, conventional[4])}`);
  }

  return ensureSafeCommitSubject(formatSubjectBody(subject, sample));
}

function formatSubjectBody(subject: string, sampleBody: string): string {
  let formatted = normalizedTaskSubject(subject);
  const sampleFirstLetter = sampleBody.match(/[A-Za-z]/)?.[0];
  if (sampleFirstLetter && sampleFirstLetter === sampleFirstLetter.toLowerCase()) {
    formatted = lowercaseFirstLetter(formatted);
  } else if (sampleFirstLetter && sampleFirstLetter === sampleFirstLetter.toUpperCase()) {
    formatted = uppercaseFirstLetter(formatted);
  }

  formatted = formatted.replace(/[.!?]+$/g, "");
  if (/\.$/.test(sampleBody.trim())) {
    formatted = `${formatted}.`;
  }
  return formatted;
}

function normalizedTaskSubject(title: string): string {
  const normalized = stripGeneratedTodoPrefix(title).replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
  return normalized || DEFAULT_COMMIT_SUBJECT;
}

function ensureSafeCommitSubject(subject: string): string {
  const normalized = stripGeneratedTodoPrefix(subject).replace(/\s+/g, " ").trim();
  return normalized || DEFAULT_COMMIT_SUBJECT;
}

function stripGeneratedTodoPrefix(subject: string): string {
  let cleaned = subject.trim();
  let previous = "";
  while (cleaned && cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(GENERATED_TODO_COMMIT_PREFIX_RE, "")
      .replace(TODO_LABEL_PREFIX_RE, "")
      .replace(/^[:\s—-]+/g, "")
      .trim();
  }
  return cleaned;
}

function lowercaseFirstLetter(value: string): string {
  return value.replace(/[A-Za-z]/, (letter) => letter.toLowerCase());
}

function uppercaseFirstLetter(value: string): string {
  return value.replace(/[A-Za-z]/, (letter) => letter.toUpperCase());
}

async function stagedArtifactPaths(root: string, runDir?: string): Promise<Set<string>> {
  const artifacts = new Set<string>();
  const runDirRel = runDir ? relToRoot(runDir, root) : "";
  const result = await runGit(root, ["diff", "--cached", "--name-only", "-z"]);
  if (result.code !== 0) {
    return artifacts;
  }

  for (const item of result.stdout.split("\0")) {
    if (!item) {
      continue;
    }
    if (path.posix.basename(item) === "TASK_RESULT.md") {
      artifacts.add(item);
      continue;
    }
    if (runDirRel && isPathAtOrUnder(item, runDirRel)) {
      artifacts.add(item);
    }
  }
  return artifacts;
}

function relToRoot(pathname: string, root: string): string {
  const absolute = resolveExistingPath(pathname);
  const resolvedRoot = resolveExistingPath(root);
  const relative = path.relative(resolvedRoot, absolute);
  if (!relative || relative === ".") {
    return "";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolute;
  }
  return toGitPath(relative);
}

function resolveExistingPath(pathname: string): string {
  const absolute = path.resolve(pathname);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function addPathIfPresent(paths: Set<string>, pathname: string): void {
  if (pathname) {
    paths.add(pathname);
  }
}

function isExcluded(pathname: string, excluded: readonly string[]): boolean {
  return excluded.some((item) => isPathAtOrUnder(pathname, item));
}

function isPathAtOrUnder(pathname: string, parent: string): boolean {
  const normalizedPath = trimTrailingSlash(toGitPath(pathname));
  const normalizedParent = trimTrailingSlash(toGitPath(parent));
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function toGitPath(value: string): string {
  return value.split(path.sep).join("/");
}

function gitError(result: GitRunResult): string {
  return (result.stderr || result.stdout || `git exited with status ${result.code}`).trim();
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0,
    };
  } catch (error) {
    if (isExecError(error)) {
      return {
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
        code: typeof error.code === "number" ? error.code : 1,
      };
    }
    throw error;
  }
}

function isExecError(error: unknown): error is { stdout?: unknown; stderr?: unknown; code?: unknown } {
  return typeof error === "object" && error !== null;
}

export const git_root = gitRoot;
export const git_dirty_paths = gitDirtyPaths;
export const unstage_paths = unstagePaths;
export const should_commit_outcome = shouldCommitOutcome;
export const commit_after_session = commitAfterSession;
