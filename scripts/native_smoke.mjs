#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const PI_BINARY = process.env.PI_BINARY || "pi";
const EXTENSION_PATH = path.resolve(process.env.PI_COORDINATOR_EXTENSION || repoRoot);
const MODEL = process.env.PI_SMOKE_MODEL || "openai-codex/gpt-5.5:minimal";
const TIMEOUT_MS = positiveInteger(process.env.PI_SMOKE_TIMEOUT_MS, 20 * 60 * 1000);
const KEEP = truthy(process.env.PI_SMOKE_KEEP);

const cases = [
  {
    name: "commit-false",
    commit: false,
    markerFile: "SMOKE_FALSE.txt",
    markerText: "commit false smoke ok",
    title: "Create non-commit smoke marker",
    goal: "Verify the native coordinator worker can modify the disposable repo while commits are disabled.",
  },
  {
    name: "commit-true",
    commit: true,
    markerFile: "SMOKE_TRUE.txt",
    markerText: "commit true smoke ok",
    title: "Create commit smoke marker",
    goal: "Verify the native coordinator worker can modify the disposable repo and the coordinator can commit eligible changes.",
  },
];

const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "pi-coordinator-native-smoke-"));
let success = false;

try {
  console.log(`Native Pi coordinator smoke root: ${smokeRoot}`);
  console.log(`Extension: ${EXTENSION_PATH}`);
  console.log(`Outer model: ${MODEL}`);

  const summaries = [];
  for (const testCase of cases) {
    summaries.push(await runSmokeCase(testCase));
  }

  success = true;
  console.log("\nNative Pi coordinator smoke passed:");
  for (const summary of summaries) {
    const commitText = summary.commitHash ? `, coordinator commit ${summary.commitHash}` : "";
    console.log(`- ${summary.name}: ${summary.status}, marker verified${commitText}`);
  }
} finally {
  if (success && !KEEP) {
    await rm(smokeRoot, { recursive: true, force: true });
  } else {
    console.log(`Smoke artifacts kept at: ${smokeRoot}`);
  }
}

async function runSmokeCase(testCase) {
  const caseDir = path.join(smokeRoot, testCase.name);
  const repoDir = path.join(caseDir, "repo");
  await mkdir(repoDir, { recursive: true });
  initializeGitRepo(repoDir, testCase.name);

  const prompt = buildPrompt(testCase);
  const stdoutPath = path.join(caseDir, "pi.stdout.jsonl");
  const stderrPath = path.join(caseDir, "pi.stderr.log");
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "-e",
    EXTENSION_PATH,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "pi_todo_coordinator",
    "--model",
    MODEL,
    prompt,
  ];

  console.log(`\n[${testCase.name}] running Pi in ${repoDir}`);
  const result = await runProcess(PI_BINARY, args, {
    cwd: repoDir,
    env: {
      ...process.env,
      PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
    },
    timeoutMs: TIMEOUT_MS,
    stdoutPath,
    stderrPath,
  });

  if (result.code !== 0) {
    throw new Error(
      `[${testCase.name}] pi exited with ${result.code}. stdout: ${stdoutPath}; stderr: ${stderrPath}`,
    );
  }

  const events = parseJsonEvents(result.stdout);
  const coordinatorEnd = events.find(
    (event) => event.type === "tool_execution_end" && event.toolName === "pi_todo_coordinator",
  );
  if (!coordinatorEnd) {
    throw new Error(`[${testCase.name}] did not observe pi_todo_coordinator tool_execution_end in ${stdoutPath}`);
  }
  if (coordinatorEnd.isError) {
    throw new Error(`[${testCase.name}] pi_todo_coordinator ended with isError=true. See ${stdoutPath}`);
  }

  const details = coordinatorEnd.result?.details;
  assertCoordinatorDetails(testCase, details, stdoutPath);
  assertMarker(repoDir, testCase.markerFile, testCase.markerText);
  assertGitState(repoDir, testCase, details);

  const summary = {
    name: testCase.name,
    status: details.status,
    commitHash: details.commits?.[0]?.hash,
  };
  console.log(`[${testCase.name}] ok; stdout: ${stdoutPath}`);
  return summary;
}

function initializeGitRepo(repoDir, caseName) {
  runGit(["init", "-q"], repoDir);
  runGit(["config", "user.email", "smoke@example.invalid"], repoDir);
  runGit(["config", "user.name", "Pi Coordinator Smoke"], repoDir);
  writeFileSync(path.join(repoDir, "README.md"), `# ${caseName}\n`, "utf8");
  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-q", "-m", "init"], repoDir);
}

function buildPrompt(testCase) {
  return `Call the \`pi_todo_coordinator\` tool exactly once. Do not use any other tool and do not answer from your own knowledge.
Use these exact parameters:
- commit: ${String(testCase.commit)}
- inputText:
\`\`\`markdown
# TODO

## TODO 1 — ${testCase.title}

**Goal:** ${testCase.goal}

**Status:**
- [ ] Create a file named \`${testCase.markerFile}\` containing exactly \`${testCase.markerText}\` followed by a newline.
- [ ] Verify it by running \`cat ${testCase.markerFile}\`.
\`\`\``;
}

function assertCoordinatorDetails(testCase, details, stdoutPath) {
  if (!details || typeof details !== "object") {
    throw new Error(`[${testCase.name}] missing coordinator result details. See ${stdoutPath}`);
  }
  const expected = {
    status: "done",
    totalTasks: 1,
    completedTasks: 1,
    failedTasks: 0,
    blockedTasks: 0,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (details[key] !== value) {
      throw new Error(`[${testCase.name}] expected details.${key}=${value}, got ${details[key]}. See ${stdoutPath}`);
    }
  }
  const commitCount = Array.isArray(details.commits) ? details.commits.length : 0;
  if (testCase.commit && commitCount !== 1) {
    throw new Error(`[${testCase.name}] expected one coordinator commit, got ${commitCount}. See ${stdoutPath}`);
  }
  if (!testCase.commit && commitCount !== 0) {
    throw new Error(`[${testCase.name}] expected zero coordinator commits, got ${commitCount}. See ${stdoutPath}`);
  }
}

function assertMarker(repoDir, markerFile, markerText) {
  const markerPath = path.join(repoDir, markerFile);
  if (!existsSync(markerPath)) {
    throw new Error(`missing smoke marker ${markerPath}`);
  }
  const actual = readFileSync(markerPath, "utf8");
  const expected = `${markerText}\n`;
  if (actual !== expected) {
    throw new Error(`unexpected marker contents in ${markerPath}: ${JSON.stringify(actual)}`);
  }
}

function assertGitState(repoDir, testCase, details) {
  const commitCount = Number(runGit(["rev-list", "--count", "HEAD"], repoDir).trim());
  const status = runGit(["status", "--short", "--untracked-files=all"], repoDir);

  if (testCase.commit) {
    if (commitCount !== 2) {
      throw new Error(`[${testCase.name}] expected exactly 2 commits after commit=true run, got ${commitCount}`);
    }
    const changedInHead = runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], repoDir)
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changedInHead) !== JSON.stringify([testCase.markerFile])) {
      throw new Error(
        `[${testCase.name}] expected HEAD to contain only ${testCase.markerFile}, got ${changedInHead.join(", ")}`,
      );
    }
    if (!details.commits?.[0]?.hash) {
      throw new Error(`[${testCase.name}] missing commit hash in coordinator details`);
    }
    if (status.includes(testCase.markerFile)) {
      throw new Error(`[${testCase.name}] committed marker still appears dirty in git status:\n${status}`);
    }
  } else {
    if (commitCount !== 1) {
      throw new Error(`[${testCase.name}] expected no new commits after commit=false run, got ${commitCount}`);
    }
    if (!status.includes(`?? ${testCase.markerFile}`)) {
      throw new Error(`[${testCase.name}] expected uncommitted marker in git status, got:\n${status}`);
    }
  }

  const trackedArtifacts = runGit(["ls-files", "tmp/pi-coordinator"], repoDir).trim();
  if (trackedArtifacts) {
    throw new Error(`[${testCase.name}] coordinator artifacts were tracked unexpectedly:\n${trackedArtifacts}`);
  }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      appendFileSync(options.stdoutPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      appendFileSync(options.stderrPath, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function appendFileSync(filePath, chunk) {
  writeFileSync(filePath, chunk, { encoding: "utf8", flag: "a" });
}

function parseJsonEvents(stdout) {
  const events = [];
  for (const rawLine of stdout.split(/\n/)) {
    const jsonStart = rawLine.indexOf("{");
    if (jsonStart === -1) {
      continue;
    }
    const line = rawLine.slice(jsonStart).trim();
    if (!line) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit terminal control sequences next to JSON in some terminals.
      // Keep parsing best-effort; missing required events are asserted later.
    }
  }
  return events;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
