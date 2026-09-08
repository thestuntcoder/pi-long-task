import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_COORDINATOR_OPTIONS, runCoordinator, runTodoPlanner } from "../src/coordinator.ts";
import { DEFAULT_PLANNER_THINKING_LEVEL, SUPPORTED_PLANNER_THINKING_LEVELS } from "../src/planner_config.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { RunWorkerTaskOptions, SessionOutcome, WorkerSessionFactory } from "../src/worker_session.ts";

function doneOutcome(options: RunWorkerTaskOptions): SessionOutcome {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-08T12:00:00.000Z",
    endedAt: "2026-09-08T12:00:01.000Z",
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

function plannerSessionFactory(onThinkingLevel: (thinkingLevel: string | undefined) => void): WorkerSessionFactory {
  return async (options) => {
    onThinkingLevel(options.thinkingLevel);
    return {
      session: {
        async prompt() {},
        getLastAssistantText: () => generatedTodoMarkdown(["Implement the planned change"]),
        subscribe: () => () => {},
      },
    };
  };
}

test("planner defaults to the documented balanced thinking level when omitted", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-thinking-default-"));
  let directThinkingLevel: string | undefined;
  let coordinatorThinkingLevel: string | undefined;

  try {
    await runTodoPlanner({
      inputText: "Plan a simple implementation.",
      cwd,
      runDir: path.join(cwd, "direct"),
      sessionFactory: plannerSessionFactory((level) => {
        directThinkingLevel = level;
      }),
    });

    await runCoordinator({
      inputText: "Plan a simple implementation.",
      cwd,
      runId: "coordinator-default",
      commit: false,
      todoPlanner: async (options) => {
        coordinatorThinkingLevel = options.thinkingLevel;
        return generatedTodoMarkdown(["Implement the planned change"]);
      },
      workerRunner: async (options) => doneOutcome(options),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(DEFAULT_PLANNER_THINKING_LEVEL, "high");
  assert.equal(DEFAULT_COORDINATOR_OPTIONS.todoThinking, DEFAULT_PLANNER_THINKING_LEVEL);
  assert.equal(directThinkingLevel, DEFAULT_PLANNER_THINKING_LEVEL);
  assert.equal(coordinatorThinkingLevel, DEFAULT_PLANNER_THINKING_LEVEL);
});

test("every supported explicit planner thinking level is forwarded unchanged", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-thinking-overrides-"));
  const directLevels: Array<string | undefined> = [];
  const coordinatorLevels: Array<string | undefined> = [];

  const representativeRequests = [
    "Plan a small implementation with focused verification.",
    "Create 24 separately planned stories with dependencies, constraints, and verification.",
  ];

  try {
    for (const [requestIndex, inputText] of representativeRequests.entries()) {
      for (const thinkingLevel of SUPPORTED_PLANNER_THINKING_LEVELS) {
        await runTodoPlanner({
          inputText,
          cwd,
          runDir: path.join(cwd, `direct-${requestIndex}-${thinkingLevel}`),
          thinkingLevel,
          sessionFactory: plannerSessionFactory((level) => directLevels.push(level)),
        });

        await runCoordinator({
          inputText,
          cwd,
          runId: `coordinator-${requestIndex}-${thinkingLevel}`,
          commit: false,
          todoThinking: thinkingLevel,
          todoPlanner: async (options) => {
            coordinatorLevels.push(options.thinkingLevel);
            return generatedTodoMarkdown(["Implement the planned change"]);
          },
          workerRunner: async (options) => doneOutcome(options),
        });
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  const expectedLevels = representativeRequests.flatMap(() => [...SUPPORTED_PLANNER_THINKING_LEVELS]);
  assert.deepEqual(directLevels, expectedLevels);
  assert.deepEqual(coordinatorLevels, expectedLevels);
  assert.equal(directLevels.includes("xhigh"), true);
  assert.equal(coordinatorLevels.includes("xhigh"), true);
});

test("planner overrides do not alter the worker thinking default", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-worker-thinking-isolation-"));
  const workerLevels: Array<string | undefined> = [];

  try {
    await runCoordinator({
      inputText: generatedTodoMarkdown(["Use the worker default"]),
      cwd,
      runId: "worker-default-isolation",
      commit: false,
      todoThinking: "xhigh",
      workerRunner: async (options) => {
        workerLevels.push(options.thinkingLevel);
        return doneOutcome(options);
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(DEFAULT_COORDINATOR_OPTIONS.taskThinking, "high");
  assert.deepEqual(workerLevels, ["high"]);
});
