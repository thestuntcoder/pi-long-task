import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReusedAssignmentPrompt,
  createWorkerSessionResource,
  disposeWorkerSessionResource,
  runWorkerTaskAssignment,
  workerSessionStatsDelta,
  type RunWorkerTaskOptions,
  type WorkerSessionLike,
  type WorkerSessionStatsSnapshot,
} from "../src/worker_session.ts";

const priorTask = {
  taskId: "1",
  title: "Prior task",
  section: "## TODO 1 — Prior task",
};
const currentTask = {
  taskId: "2",
  title: "Current task",
  section: "## TODO 2 — Current task\n\nOnly current-task instructions.",
};

function taskResult(summary: string): string {
  return `TASK_RESULT:
status: done
summary: ${summary}
changes:
- none
verification:
- deterministic fake
remaining:
- none`;
}

function assignmentOptions(session: WorkerSessionLike, now: () => Date): RunWorkerTaskOptions {
  return {
    cwd: "/repo/worktree",
    todoPath: "/repo/worktree/TODO.md",
    task: currentTask,
    attempt: 1,
    commitRequested: false,
    maxBashTimeoutSeconds: 300,
    taskTimeoutSeconds: 0,
    now,
    sessionFactory: async () => ({ session }),
  };
}

class InvocationFakeSession implements WorkerSessionLike {
  readonly prompts: string[] = [];
  readonly messages: unknown[];
  private listeners: Array<(event: unknown) => void> = [];
  private readonly responses: string[];

  constructor(priorMessages: unknown[], responses: string[]) {
    this.messages = [...priorMessages];
    this.responses = [...responses];
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) return;

    const message = { id: `current-${this.prompts.length}`, role: "assistant", content: response };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end", message, toolResults: [] });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

function fakeClock(...isoTimes: string[]): () => Date {
  const times = isoTimes.map((value) => new Date(value));
  let index = 0;
  return () => new Date(times[Math.min(index++, times.length - 1)]?.getTime() ?? 0);
}

test("reused prompt establishes a complete task boundary", () => {
  const prompt = buildReusedAssignmentPrompt(
    {
      todoPath: "/repo/worktree/TODO.md",
      task: currentTask,
      attempt: 3,
      commitRequested: false,
      maxBashTimeoutSeconds: 300,
    },
    priorTask,
  );

  assert.match(prompt, /^Pi Long Task assignment boundary:/);
  assert.match(prompt, /The prior assignment TODO 1 — Prior task has ended\./);
  assert.match(prompt, /A new, independent assignment has begun: TODO 2 — Current task\./);
  assert.match(prompt, /Assigned task: `TODO 2 — Current task`/);
  assert.match(prompt, /Attempt: 3/);
  assert.match(prompt, /Only current-task instructions\./);
  assert.match(prompt, /Do not repeat or reuse the prior assignment's TASK_RESULT\./);
  assert.match(prompt, /TASK_RESULT:\nstatus: done\|partial\|blocked\|failed/);
});

test("reused assignment extracts only current-invocation messages and uses an injected clock", async () => {
  const oldResult = taskResult("PRIOR-RESULT-MUST-NOT-LEAK");
  const currentResult = taskResult("CURRENT-RESULT");
  const session = new InvocationFakeSession([{ role: "assistant", content: oldResult }], [currentResult]);
  const resource = await createWorkerSessionResource(
    assignmentOptions(session, () => new Date(0)),
    async () => ({
      session,
    }),
  );
  resource.completedAssignments = 1;

  const outcome = await runWorkerTaskAssignment(
    assignmentOptions(session, fakeClock("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")),
    resource,
    { previousTask: priorTask },
  );

  assert.equal(outcome.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(outcome.endedAt, "2026-01-01T00:00:01.000Z");
  assert.equal(outcome.reportedStatus, "done");
  assert.match(outcome.assistantText, /CURRENT-RESULT/);
  assert.doesNotMatch(outcome.assistantText, /PRIOR-RESULT-MUST-NOT-LEAK/);
  assert.equal(session.prompts.length, 1);
});

test("a silent reused invocation cannot satisfy its result contract from a prior message", async () => {
  const oldResult = taskResult("STALE-DONE");
  const session = new InvocationFakeSession([{ role: "assistant", content: oldResult }], []);
  const resource = await createWorkerSessionResource(
    assignmentOptions(session, () => new Date(0)),
    async () => ({
      session,
    }),
  );
  resource.completedAssignments = 1;

  const outcome = await runWorkerTaskAssignment(
    assignmentOptions(session, fakeClock("2026-02-01T00:00:00.000Z", "2026-02-01T00:00:01.000Z")),
    resource,
    { previousTask: priorTask },
  );

  assert.equal(outcome.done, false);
  assert.equal(outcome.reportedStatus, "unknown");
  assert.doesNotMatch(outcome.assistantText, /STALE-DONE/);
  assert.equal(session.prompts.length, 2, "the current invocation receives its own missing-result reminder");
  assert.match(session.prompts[1] ?? "", /previous response did not include a complete machine-readable TASK_RESULT/);
});

test("cumulative session statistics produce nonnegative assignment deltas across reuse and resets", () => {
  const snapshot = (cost: number, total: number): WorkerSessionStatsSnapshot => ({
    cost,
    tokens: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
  });

  assert.deepEqual(workerSessionStatsDelta(undefined, snapshot(5, 100), true), snapshot(5, 100));
  assert.deepEqual(workerSessionStatsDelta(snapshot(5, 100), snapshot(9, 180), false), snapshot(4, 80));
  assert.deepEqual(workerSessionStatsDelta(snapshot(9, 180), snapshot(2, 40), false), snapshot(2, 40));
  assert.equal(workerSessionStatsDelta(undefined, snapshot(2, 40), false), undefined);
  assert.equal(workerSessionStatsDelta(snapshot(2, 40), undefined, false), undefined);
});

test("session resources dispose exactly once under concurrent and exceptional cleanup", async (t) => {
  await t.test("concurrent normal disposal", async () => {
    let disposeCalls = 0;
    let releaseDispose: (() => void) | undefined;
    let markDisposeStarted: (() => void) | undefined;
    const disposeStarted = new Promise<void>((resolve) => {
      markDisposeStarted = resolve;
    });
    const session: WorkerSessionLike = {
      subscribe: () => () => {},
      prompt: async () => {},
      dispose: async () => {
        disposeCalls += 1;
        markDisposeStarted?.();
        await new Promise<void>((resolve) => {
          releaseDispose = resolve;
        });
      },
    };
    const resource = await createWorkerSessionResource({ cwd: "/repo" }, async () => ({ session }));

    const first = disposeWorkerSessionResource(resource);
    await disposeStarted;
    const second = disposeWorkerSessionResource(resource);
    assert.equal(disposeCalls, 1);
    releaseDispose?.();
    await Promise.all([first, second]);
    await disposeWorkerSessionResource(resource);
    assert.equal(disposeCalls, 1);
    assert.equal(resource.disposed, true);
  });

  await t.test("throwing disposal still relinquishes ownership", async () => {
    let disposeCalls = 0;
    const session: WorkerSessionLike = {
      subscribe: () => () => {},
      prompt: async () => {},
      dispose: () => {
        disposeCalls += 1;
        throw new Error("fake dispose failure");
      },
    };
    const resource = await createWorkerSessionResource({ cwd: "/repo" }, async () => ({ session }));

    await assert.rejects(disposeWorkerSessionResource(resource), /fake dispose failure/);
    await disposeWorkerSessionResource(resource);
    assert.equal(disposeCalls, 1);
    assert.equal(resource.disposed, true);
  });
});
