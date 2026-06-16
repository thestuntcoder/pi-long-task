import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { commitAfterSession, gitDirtyPaths, gitRoot, shouldCommitOutcome } from "../src/git.ts";
import type { SessionOutcome } from "../src/worker_session.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

function outcome(
  status = "done",
): Pick<SessionOutcome, "task" | "reportedStatus" | "done" | "error" | "timedOut" | "aborted"> {
  return {
    task: { taskId: "7", title: "Git safety", section: "## TODO 7 — Git safety\n" },
    reportedStatus: status,
    done: status === "done",
    timedOut: false,
    aborted: false,
  };
}

const repo = await mkdtemp(path.join(os.tmpdir(), "pi-coordinator-git-test-"));
try {
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Pi Test"]);
  await git(repo, ["config", "user.email", "pi-test@example.invalid"]);

  await writeFile(path.join(repo, "preexisting.txt"), "clean\n", "utf8");
  await writeFile(path.join(repo, "kept.txt"), "clean\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  assert.equal(await gitRoot(repo), await realpath(repo));

  const runDir = path.join(repo, "tmp", "pi-coordinator", "run-1");
  const resultPath = path.join(runDir, "TASK_RESULT.md");
  const todoPath = path.join(runDir, "TODO.md");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(repo, "preexisting.txt"), "dirty before worker\n", "utf8");
  await writeFile(resultPath, "result before worker\n", "utf8");
  await writeFile(todoPath, "todo before worker\n", "utf8");

  const preExistingDirty = await gitDirtyPaths(repo, resultPath, todoPath, runDir);
  assert.deepEqual([...preExistingDirty].sort(), ["preexisting.txt"]);

  await writeFile(path.join(repo, "kept.txt"), "changed by worker\n", "utf8");
  await writeFile(path.join(repo, "new-worker-file.txt"), "new by worker\n", "utf8");
  await writeFile(resultPath, "result after worker\n", "utf8");
  await writeFile(todoPath, "todo after worker\n", "utf8");

  const commit = await commitAfterSession({
    cwd: repo,
    resultPath,
    todoPath,
    runDir,
    outcome: outcome("done"),
    preExistingDirtyPaths: preExistingDirty,
  });
  assert.match(commit.hash ?? "", /^[0-9a-f]+$/);
  assert.equal(commit.error, undefined);

  const committedFiles = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
  assert.match(committedFiles, /kept\.txt/);
  assert.match(committedFiles, /new-worker-file\.txt/);
  assert.doesNotMatch(committedFiles, /preexisting\.txt/);
  assert.doesNotMatch(committedFiles, /TASK_RESULT\.md/);
  assert.doesNotMatch(committedFiles, /tmp\/pi-coordinator/);

  assert.equal(await readFile(path.join(repo, "preexisting.txt"), "utf8"), "dirty before worker\n");
  const status = await git(repo, ["status", "--short"]);
  assert.match(status, / M preexisting\.txt/);
  assert.match(status, /\?\? tmp\//);

  assert.equal(shouldCommitOutcome({ reportedStatus: "done", timedOut: false, aborted: false }), true);
  assert.equal(shouldCommitOutcome({ reportedStatus: "partial", timedOut: false, aborted: false }), true);
  assert.equal(shouldCommitOutcome({ reportedStatus: "done", error: "boom", timedOut: false, aborted: false }), false);
  assert.equal(shouldCommitOutcome({ reportedStatus: "done", timedOut: true, aborted: false }), false);
} finally {
  await rm(repo, { recursive: true, force: true });
}
