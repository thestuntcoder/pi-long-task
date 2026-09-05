import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinator } from "../src/coordinator.ts";
import { generatedTodoMarkdown } from "../src/todo_generator.ts";
import type { WorkerSessionFactory, WorkerSessionLike } from "../src/worker_session.ts";

const doneResult = (summary: string) =>
  `TASK_RESULT:\nstatus: done\nsummary: ${summary}\nchanges:\n- preserved\nverification:\n- verified\nremaining:\n- none`;

class RecoveringWorkerSession implements WorkerSessionLike {
  readonly messages: unknown[] = [];
  readonly prompts: string[] = [];
  readonly sessionId: string;
  disposeCalls = 0;
  cumulativeCost = 0;
  private listeners: Array<(event: unknown) => void> = [];
  private readonly handlePrompt: (session: RecoveringWorkerSession, prompt: string) => Promise<string>;

  constructor(sessionId: string, handlePrompt: (session: RecoveringWorkerSession, prompt: string) => Promise<string>) {
    this.sessionId = sessionId;
    this.handlePrompt = handlePrompt;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    const response = await this.handlePrompt(this, prompt);
    const message = { id: `${this.sessionId}-${this.prompts.length}`, role: "assistant", content: response };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end", message });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  getContextUsage(): unknown {
    return { percent: 10 };
  }

  getSessionStats(): unknown {
    return {
      cost: this.cumulativeCost,
      tokens: {
        input: this.cumulativeCost * 10,
        output: this.cumulativeCost * 10,
        cacheRead: 0,
        cacheWrite: 0,
        total: this.cumulativeCost * 20,
      },
    };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  tool(event: unknown): void {
    this.emit(event);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

test("transient worker failure resumes the same TODO in a fresh session without consuming an attempt", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-worker-network-recovery-"));
  const markerPath = path.join(cwd, "partial-side-effect.txt");
  const created: RecoveringWorkerSession[] = [];
  let sideEffectWrites = 0;

  const factory: WorkerSessionFactory = async () => {
    const index = created.length;
    const session = new RecoveringWorkerSession(`worker-${index + 1}`, async (current, prompt) => {
      if (index === 0 && /Assigned task: `TODO 1 —/.test(prompt)) {
        current.cumulativeCost = 0.2;
        return doneResult("first TODO complete");
      }
      if (index === 0 && /Assigned task: `TODO 2 —/.test(prompt)) {
        current.tool({ type: "tool_execution_start", toolName: "write", args: { path: markerPath } });
        sideEffectWrites += 1;
        await writeFile(markerPath, "already-created", "utf8");
        current.tool({ type: "tool_execution_end", toolName: "write", isError: false });
        current.cumulativeCost = 0.6;
        throw Object.assign(new Error("fetch failed after bounded provider retries"), { code: "ECONNRESET" });
      }

      assert.equal(index, 1, "network continuation must allocate exactly one replacement session");
      assert.equal(created[0].disposeCalls, 1, "errored session must be rotated before resumption");
      assert.match(prompt, /Network recovery continuation \(network retry 1, still ordinary task attempt 1\)/);
      assert.match(
        prompt,
        /Never blindly replay prior edits, commands, commits, external writes, or other side effects/,
      );
      assert.equal(await readFile(markerPath, "utf8"), "already-created");
      const evidencePath = /Durable interruption evidence was recorded in `([^`]+)`/.exec(prompt)?.[1];
      assert.ok(evidencePath);
      const evidence = await readFile(evidencePath, "utf8");
      assert.match(evidence, /ordinary attempt 1, network interruption 1/);
      assert.match(evidence, /not an ordinary task attempt/);
      assert.match(evidence, /fetch failed after bounded provider retries/);
      const todoPath = /Assigned TODO file path: `([^`]+)`/.exec(prompt)?.[1];
      assert.ok(todoPath);
      const todo = await readFile(todoPath, "utf8");
      assert.match(todo, /- \[x\] TODO 1/);
      assert.match(todo, /- \[ \] TODO 2/);
      current.cumulativeCost = 0.6;
      return doneResult("resumed without replaying the prior write");
    });
    created.push(session);
    return { session };
  };

  try {
    const result = await runCoordinator({
      cwd,
      runId: "worker-network-recovery",
      inputText: generatedTodoMarkdown(["Complete before outage", "Resume after partial tool work"]),
      commit: false,
      taskTimeoutMs: 0,
      maxAttemptsPerTask: 1,
      workerSessionFactory: factory,
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 100 },
    });

    assert.equal(result.status, "done");
    assert.equal(result.completedTasks, 2);
    assert.equal(result.attemptedTasks, 2, "the network wait/retry must not become an ordinary task attempt");
    assert.deepEqual(
      result.attempts.map((attempt) => [attempt.taskId, attempt.attempt]),
      [
        ["1", 1],
        ["2", 1],
      ],
    );
    assert.equal(created.length, 2);
    assert.equal(created[0].disposeCalls, 1);
    assert.equal(created[1].disposeCalls, 1);
    assert.equal(sideEffectWrites, 1, "the completed write must not be replayed");
    assert.equal(result.workerCostTotal, 1.2);
    assert.equal(result.outcomes[1].workerCostTotal, 1);
    assert.deepEqual(result.workerUsageTotal, {
      input: 12,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      total: 24,
    });
    assert.match(await readFile(result.todoPath, "utf8"), /- \[x\] TODO 1[\s\S]*- \[x\] TODO 2/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deterministic worker failures do not enter coordinator network recovery", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-worker-network-fail-fast-"));
  const created: RecoveringWorkerSession[] = [];
  try {
    const result = await runCoordinator({
      cwd,
      runId: "worker-network-fail-fast",
      inputText: generatedTodoMarkdown(["Reject invalid credentials"]),
      commit: false,
      taskTimeoutMs: 0,
      maxAttemptsPerTask: 3,
      workerSessionFactory: async () => {
        const session = new RecoveringWorkerSession(`invalid-${created.length + 1}`, async () => {
          throw Object.assign(new Error("request rejected"), { status: 401 });
        });
        created.push(session);
        return { session };
      },
      networkRecovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 100 },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.attemptedTasks, 1);
    assert.equal(created.length, 1);
    const evidence = await readFile(result.taskResultPath, "utf8");
    assert.doesNotMatch(evidence, /network interruption/);
    assert.match(evidence, /request rejected/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
