import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator, type TodoPlanner } from "../src/coordinator.ts";
import { SerializedSteeringQueue } from "../src/steering.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import { parseTasks } from "../src/todo_parser.ts";
import type {
  RunWorkerTaskOptions,
  SessionOutcome,
  WorkerSessionFactory,
  WorkerSessionLike,
} from "../src/worker_session.ts";

const recoveryConfig = { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 1_000 } as const;

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-planner-network-recovery-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function doneOutcome(options: RunWorkerTaskOptions): Promise<SessionOutcome> {
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt: "2026-09-05T00:00:00.000Z",
    endedAt: "2026-09-05T00:00:01.000Z",
    reportedStatus: "done",
    done: true,
    assistantText: `TASK_RESULT:\nstatus: done\nsummary: completed ${options.task.title}\nchanges:\n- none\nverification:\n- passed\nremaining:\n- none`,
    contextObservations: [],
    compactionEvents: [],
    events: [],
    workerCostTotal: 0,
    shutdownRequested: false,
    timedOut: false,
    aborted: false,
  };
}

class PlannerSession implements WorkerSessionLike {
  readonly messages: unknown[] = [];
  readonly sessionId: string;
  disposeCalls = 0;
  private readonly response: string | Error;

  constructor(sessionId: string, response: string | Error) {
    this.sessionId = sessionId;
    this.response = response;
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(): Promise<void> {
    if (this.response instanceof Error) throw this.response;
    this.messages.push({ role: "assistant", content: this.response });
  }

  getLastAssistantText(): string {
    const message = this.messages.at(-1) as { content?: string } | undefined;
    return message?.content ?? "";
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

function todo(titles: readonly string[]): string {
  const progress = titles.map((title, index) => `- [ ] TODO ${index + 1} — ${title}`).join("\n");
  const sections = titles
    .map(
      (title, index) => `## TODO ${index + 1} — ${title}
<!-- pi-long-task-id: ${title.toLowerCase().replaceAll(" ", "-")} -->

**Goal:** Complete ${title}.

**Status:**
- [ ] Implement ${title}

**Verify:**
- Run focused tests.

**Done when:** ${title} is complete.`,
    )
    .join("\n\n");
  return `# Pi Long Task TODO

## Progress

${progress}

---

${sections}
`;
}

test("initial planning recovers before and during provider calls in rotated sessions", async () => {
  await withTempDir(async (cwd) => {
    const sessions: PlannerSession[] = [];
    let factoryCalls = 0;
    const sessionFactory: WorkerSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw Object.assign(new Error("DNS lookup failed after bounded retries"), { code: "ENOTFOUND" });
      }
      if (factoryCalls === 2) {
        const session = new PlannerSession(
          "errored-planner",
          Object.assign(new Error("provider request rejected"), { status: 503 }),
        );
        sessions.push(session);
        return { session };
      }

      assert.equal(sessions[0]?.disposeCalls, 1, "the errored planner session must be disposed before retry");
      const session = new PlannerSession("replacement-planner", generatedTodoMarkdown(["Recovered plan"]));
      sessions.push(session);
      return { session };
    };

    const result = await runCoordinator({
      cwd,
      runId: "initial-planner-recovery",
      inputText: "Create a robust implementation plan for this request.",
      commit: false,
      todoTimeoutMs: 1_234,
      maxAttemptsPerTask: 1,
      todoSessionFactory: sessionFactory,
      workerRunner: doneOutcome,
      networkRecovery: recoveryConfig,
    });

    assert.equal(result.status, "done");
    assert.equal(factoryCalls, 3);
    assert.equal(sessions[0]?.disposeCalls, 1);
    assert.equal(sessions[1]?.disposeCalls, 1);
    assert.equal(result.attemptedTasks, 1, "network retries must not consume worker attempts");
    assert.deepEqual(
      parseTasks(await readFile(result.todoPath, "utf8")).map((task) => task.title),
      ["Recovered plan"],
    );
  });
});

test("initial planner recovery keeps outage waiting separate from the planner timeout and repair budget", async () => {
  await withTempDir(async (cwd) => {
    const seenTimeouts: Array<number | undefined> = [];
    let calls = 0;
    const planner: TodoPlanner = async (options) => {
      calls += 1;
      seenTimeouts.push(options.timeoutMs);
      if (calls === 1) {
        throw Object.assign(new Error("connection reset after provider retries"), { code: "ECONNRESET" });
      }
      return generatedTodoMarkdown(["Plan after outage"]);
    };

    const result = await runCoordinator({
      cwd,
      runId: "planner-timeout-policy",
      inputText: "Create a plan after connectivity returns.",
      commit: false,
      todoTimeoutMs: 4_321,
      maxAttemptsPerTask: 1,
      todoPlanner: planner,
      workerRunner: doneOutcome,
      networkRecovery: recoveryConfig,
    });

    assert.equal(result.status, "done");
    assert.equal(calls, 2);
    assert.deepEqual(seenTimeouts, [4_321, 4_321]);
    assert.equal(result.attemptedTasks, 1);
  });
});

test("deterministic initial planning failures remain fail-fast", async () => {
  await withTempDir(async (cwd) => {
    const cases = [
      Object.assign(new Error("invalid provider request"), { status: 400 }),
      Object.assign(new Error("provider rejected credentials"), { status: 401 }),
      Object.assign(new Error("usage unavailable"), { status: 429, code: "INSUFFICIENT_QUOTA" }),
    ];

    for (const [index, failure] of cases.entries()) {
      let calls = 0;
      const result = await runCoordinator({
        cwd,
        runId: `deterministic-planner-${index}`,
        inputText: "Plan a request that the provider rejects.",
        commit: false,
        todoPlanner: async () => {
          calls += 1;
          throw failure;
        },
        workerRunner: doneOutcome,
        networkRecovery: recoveryConfig,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.attemptedTasks, 0);
      assert.equal(calls, 1, `deterministic case ${index} must not be retried`);
    }
  });
});

test("steering recovery preserves accepted revisions and completed work without duplicate acceptance", async () => {
  await withTempDir(async (cwd) => {
    const queue = new SerializedSteeringQueue({ queueId: "recover-steering" });
    const workerCalls: string[] = [];
    const acceptedRevisionIds: string[] = [];
    const revisionTimeouts: Array<number | undefined> = [];
    let firstQueued = false;
    let secondQueued = false;
    let secondRevisionCalls = 0;

    const result = await runCoordinator({
      cwd,
      runId: "steering-planner-recovery",
      inputText: todo(["Foundation", "Original follow-up"]),
      commit: false,
      todoTimeoutMs: 5_678,
      maxAttemptsPerTask: 1,
      steeringQueue: queue,
      todoPlanner: async (options) => {
        const request = options.planRevision;
        assert.ok(request);
        revisionTimeouts.push(options.timeoutMs);
        assert.match(request.relevantResults[0]?.summary ?? "", /summary: completed Foundation/);

        if (request.guidance.includes("first insertion")) {
          assert.deepEqual(
            parseTasks(request.currentTodoMarkdown).map((task) => task.title),
            ["Foundation", "Original follow-up"],
          );
          return todo(["Foundation", "Accepted insertion", "Original follow-up"]);
        }

        assert.match(request.guidance, /second insertion/);
        assert.deepEqual(
          parseTasks(request.currentTodoMarkdown).map((task) => task.title),
          ["Foundation", "Accepted insertion", "Original follow-up"],
        );
        secondRevisionCalls += 1;
        if (secondRevisionCalls === 1) {
          throw Object.assign(new Error("steering stream disconnected"), { code: "ECONNRESET" });
        }
        return todo(["Foundation", "Accepted insertion", "Recovered insertion", "Original follow-up"]);
      },
      workerRunner: async (options) => {
        workerCalls.push(options.task.title);
        return { ...(await doneOutcome(options)), workerCostTotal: 0.25 };
      },
      onPlanRevisionAccepted: (revision) => {
        acceptedRevisionIds.push(revision.revisionId);
      },
      onProgress: (update) => {
        if (update.phase === "task_done" && update.title === "Foundation" && !firstQueued) {
          firstQueued = true;
          queue.enqueue("Apply the first insertion.", "interactive");
        }
        if (update.phase === "planned" && update.status === "revised" && !secondQueued) {
          secondQueued = true;
          queue.enqueue("Apply the second insertion after the accepted one.", "interactive");
        }
      },
      networkRecovery: recoveryConfig,
    });

    assert.equal(result.status, "done");
    assert.equal(secondRevisionCalls, 2);
    assert.deepEqual(revisionTimeouts, [5_678, 5_678, 5_678]);
    assert.equal(acceptedRevisionIds.length, 2, "each steering message must be accepted exactly once");
    assert.equal(new Set(acceptedRevisionIds).size, 2);
    assert.deepEqual(workerCalls, ["Foundation", "Accepted insertion", "Recovered insertion", "Original follow-up"]);
    assert.equal(workerCalls.filter((title) => title === "Foundation").length, 1);
    assert.equal(result.attemptedTasks, 4);
    assert.equal(result.workerCostTotal, 1, "accepted revisions and planner recovery must not reset worker costs");
    assert.deepEqual(
      parseTasks(await readFile(result.todoPath, "utf8")).map((task) => [task.title, task.done]),
      [
        ["Foundation", true],
        ["Accepted insertion", true],
        ["Recovered insertion", true],
        ["Original follow-up", true],
      ],
    );
  });
});

test("deterministic steering failure does not retry or replace the accepted plan", async () => {
  await withTempDir(async (cwd) => {
    const queue = new SerializedSteeringQueue({ queueId: "fail-fast-steering" });
    let plannerCalls = 0;
    let revisionAccepted = false;
    let guidanceQueued = false;

    const result = await runCoordinator({
      cwd,
      runId: "steering-planner-fail-fast",
      inputText: todo(["Foundation", "Original follow-up"]),
      commit: false,
      maxAttemptsPerTask: 1,
      steeringQueue: queue,
      todoPlanner: async () => {
        plannerCalls += 1;
        throw Object.assign(new Error("provider quota exhausted"), {
          status: 429,
          code: "QUOTA_EXCEEDED",
        });
      },
      workerRunner: doneOutcome,
      onPlanRevisionAccepted: () => {
        revisionAccepted = true;
      },
      onProgress: (update) => {
        if (update.phase === "task_done" && update.title === "Foundation" && !guidanceQueued) {
          guidanceQueued = true;
          queue.enqueue("Insert work that cannot be planned.", "interactive");
        }
      },
      networkRecovery: recoveryConfig,
    });

    assert.equal(result.status, "done");
    assert.equal(plannerCalls, 1);
    assert.equal(revisionAccepted, false);
    assert.equal(queue.pendingMessages()[0]?.status, "failed");
    assert.deepEqual(
      parseTasks(await readFile(result.todoPath, "utf8")).map((task) => task.title),
      ["Foundation", "Original follow-up"],
    );
  });
});
