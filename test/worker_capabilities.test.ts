import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinator, runTodoPlanner, type CoordinatorProgressUpdate } from "../src/coordinator.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import { detectUnavailableWorkerCapabilities, type IsolatedWorkerCapabilities } from "../src/worker_capabilities.ts";
import type { RunWorkerTaskOptions, SessionOutcome } from "../src/worker_session.ts";

const isolatedCapabilities: IsolatedWorkerCapabilities = {
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  extensionsEnabled: false,
};

const explicitExtension = detectUnavailableWorkerCapabilities(
  "You must use the Chrome browser extension to inspect the rendered page.",
  isolatedCapabilities,
);
assert.equal(explicitExtension.length, 1);
assert.equal(explicitExtension[0].code, "unavailable_browser_capability");
assert.deepEqual(explicitExtension[0].requestedCapabilities, ["Chrome/browser extension runtime"]);
assert.match(explicitExtension[0].message, /isolated Pi Long Task workers disable extensions/i);
assert.match(explicitExtension[0].message, /cannot silently use the requested Chrome\/browser extension runtime/i);
assert.match(explicitExtension[0].message, /supported command-line mechanism via bash/i);
assert.match(explicitExtension[0].message, /supply the page or source content/i);
assert.match(explicitExtension[0].message, /run will continue/i);
assert.match(explicitExtension[0].message, /must report blocked instead of claiming/i);
assert.match(explicitExtension[0].planningConstraint, /Do not create or execute tasks that assume/i);
assert.match(explicitExtension[0].planningConstraint, /never claim it was used/i);

assert.equal(
  detectUnavailableWorkerCapabilities("Chrome DevTools MCP is required for this audit.", isolatedCapabilities).length,
  1,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Use the web_fetch tool to load the public docs.", isolatedCapabilities).length,
  1,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Use Chrome to inspect the authenticated page.", isolatedCapabilities).length,
  1,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Build a Chrome extension that supports Firefox too.", isolatedCapabilities)
    .length,
  0,
  "building an extension must not be confused with requiring workers to load one",
);
assert.equal(
  detectUnavailableWorkerCapabilities("Make the application compatible with Chrome.", isolatedCapabilities).length,
  0,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Do not use a browser extension; use curl through bash.", isolatedCapabilities)
    .length,
  0,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Fetch the public docs with curl via bash.", isolatedCapabilities).length,
  0,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Refactor the parser and run its unit tests.", isolatedCapabilities).length,
  0,
);
assert.equal(
  detectUnavailableWorkerCapabilities("Use the browser tool for this audit.", {
    tools: [...isolatedCapabilities.tools, "browser"],
    extensionsEnabled: false,
  }).length,
  0,
  "an explicitly requested direct tool is available when it is in the actual worker tool set",
);
assert.equal(
  detectUnavailableWorkerCapabilities("Use the Chrome browser extension for this audit.", {
    tools: isolatedCapabilities.tools,
    extensionsEnabled: true,
  }).length,
  0,
  "an extension request is available when the actual worker profile enables extensions",
);

function doneOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "start",
    endedAt: "end",
    reportedStatus: "done",
    done: true,
    assistantText:
      "TASK_RESULT:\nstatus: done\nsummary: complete\nchanges:\n- none\nverification:\n- not run\nremaining:\n- none",
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-long-task-capabilities-"));
try {
  const plannerPrompts: string[] = [];
  const planned = await runTodoPlanner({
    inputText: "Inspect the site; you must use the Chrome browser extension.",
    cwd: tempRoot,
    runDir: path.join(tempRoot, "planner"),
    timeoutMs: 1_000,
    sessionFactory: async () => ({
      session: {
        async prompt(prompt) {
          plannerPrompts.push(prompt);
        },
        getLastAssistantText: () => generatedTodoMarkdown(["Inspect site"]),
        subscribe: () => () => {},
      },
    }),
  });
  assert.match(plannerPrompts[0], /Worker capability constraints/);
  assert.match(plannerPrompts[0], /extensions are disabled/i);
  assert.match(planned, /Isolated-worker capability constraint:/);
  assert.match(planned, /never claim it was used/i);

  const warningUpdates: CoordinatorProgressUpdate[] = [];
  const workerGlobalInstructions: Array<string | undefined> = [];
  const alternativeRun = await runCoordinator({
    inputText:
      "- Use the Chrome browser extension if available, otherwise fetch the public page via bash\n- Summarize the supplied page content",
    commit: false,
    cwd: tempRoot,
    runId: "browser-alternative",
    workerRunner: async (options) => {
      workerGlobalInstructions.push(options.globalInstructions);
      return doneOutcome(options);
    },
    onProgress: (update) => warningUpdates.push(update),
  });
  assert.equal(alternativeRun.status, "done", "a safe available alternative must not reject the run");
  assert.equal(alternativeRun.capabilityWarnings?.length, 1);
  assert.equal(warningUpdates[0]?.phase, "capability_warning");
  assert.equal(warningUpdates[0]?.capabilityWarning?.code, "unavailable_browser_capability");
  assert.match(warningUpdates[0]?.message ?? "", /run will continue/i);
  assert.ok(workerGlobalInstructions.every((instructions) => /extensions are disabled/i.test(instructions ?? "")));
  assert.match(alternativeRun.message, /Worker capability warnings:/);
  assert.match(alternativeRun.message, /supply the page or source content/i);
  assert.match(await readFile(alternativeRun.todoPath, "utf8"), /Isolated-worker capability constraint:/);
  assert.match(await readFile(alternativeRun.taskResultPath, "utf8"), /## Worker capability warnings/);

  const fetchUpdates: CoordinatorProgressUpdate[] = [];
  const fetchRun = await runCoordinator({
    inputText: "- Fetch public docs with curl via bash\n- Summarize the fetched docs",
    commit: false,
    cwd: tempRoot,
    runId: "available-fetch",
    workerRunner: async (options) => doneOutcome(options),
    onProgress: (update) => fetchUpdates.push(update),
  });
  assert.equal(fetchRun.status, "done");
  assert.deepEqual(fetchRun.capabilityWarnings, []);
  assert.equal(
    fetchUpdates.some((update) => update.phase === "capability_warning"),
    false,
  );
  assert.doesNotMatch(fetchRun.message, /Worker capability warnings:/);

  const unrelatedRun = await runCoordinator({
    inputText: "- Refactor parser\n- Run parser tests",
    commit: false,
    cwd: tempRoot,
    runId: "unrelated",
    workerRunner: async (options) => doneOutcome(options),
  });
  assert.equal(unrelatedRun.status, "done");
  assert.deepEqual(unrelatedRun.capabilityWarnings, []);
  assert.doesNotMatch(await readFile(unrelatedRun.todoPath, "utf8"), /Isolated-worker capability constraint:/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
