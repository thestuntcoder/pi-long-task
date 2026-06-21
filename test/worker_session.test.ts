import assert from "node:assert/strict";

import {
  assistantMessageText,
  assistantTextFromEvent,
  buildCompactionInstructions,
  buildMissingTaskResultMessage,
  buildShutdownMessage,
  disableExtensionsForWorker,
  buildTaskPrompt,
  buildTimeLimitMessage,
  lastAssistantTextFromEvents,
  lastAssistantTextFromMessages,
  runWorkerTask,
  workerUsageCostFromEvent,
  workerUsageCostFromStats,
} from "../src/worker_session.ts";

const task = {
  taskId: "4",
  title: "Port worker prompt and TASK_RESULT parsing",
  section: `## TODO 4 — Port worker prompt and TASK_RESULT parsing

**Goal:** Port prompt construction and worker result parsing into TypeScript.

**Status:**
- [ ] Build assigned-task worker prompt`,
};

const prompt = buildTaskPrompt({
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 2,
  commitRequested: true,
  previousAttempts: "Attempt 1 was partial.",
  globalInstructions: "Global guardrail.",
  maxBashTimeoutSeconds: 300,
});

assert.match(prompt, /You are one Pi SDK worker session assigned to exactly one TODO task\./);
assert.match(prompt, /Assigned TODO file path: `\/tmp\/TODO.md`/);
assert.match(prompt, /Assigned task: `TODO 4 — Port worker prompt and TASK_RESULT parsing`/);
assert.match(prompt, /Attempt: 2/);
assert.match(prompt, /Pi Long Task will commit after your session if needed\. Do not run git commit\./);
assert.match(prompt, /Global instructions from the TODO file apply to this task:/);
assert.match(prompt, /```markdown\nGlobal guardrail\.\n```/);
assert.match(prompt, /Assigned task content only:/);
assert.match(prompt, /Previous attempts for this same assigned task/);
assert.match(prompt, /Do not run bash commands with timeout greater than 300 seconds/);
assert.ok(
  prompt.endsWith("Only use `status: done` if the assigned task is fully complete and verified as far as practical."),
);

const noCommitPrompt = buildTaskPrompt({
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 120,
});
assert.match(noCommitPrompt, /Do not run git commit\. Pi Long Task was started with commits disabled\./);
assert.doesNotMatch(noCommitPrompt, /Previous attempts for this same assigned task/);

assert.equal(
  buildTimeLimitMessage(12.4),
  "Pi Long Task notice: this worker session has reached its 12s time budget.\nStop after the current safe point. Do not start more implementation work.\nFinish with the required TASK_RESULT block now.\nUse `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.",
);
assert.equal(
  buildShutdownMessage(91.23),
  "Pi Long Task notice: context usage is 91.2%, above the 85% shutdown threshold.\nStop after the current safe point. Do not start more implementation work.\nLeave files in a safe state and finish with the required TASK_RESULT block.\nUse `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.",
);
assert.equal(
  buildCompactionInstructions(task),
  "Keep only information needed to finish assigned task TODO 4 — Port worker prompt and TASK_RESULT parsing: relevant files inspected,\nedits made, verification run, failures, and remaining steps. Drop unrelated details.",
);

assert.equal(assistantMessageText({ role: "user", content: "ignore" }), "");
assert.equal(assistantMessageText({ role: "assistant", content: "plain text" }), "plain text");
assert.equal(
  assistantMessageText({
    role: "assistant",
    content: [
      { type: "text", text: "hello " },
      { type: "tool_use", text: "ignored" },
      { type: "output_text", text: "world" },
    ],
  }),
  "hello world",
);
assert.equal(
  lastAssistantTextFromMessages([
    { role: "assistant", content: "first" },
    { role: "user", content: "ignored" },
    { role: "assistant", content: [{ type: "text", text: "last" }] },
  ]),
  "last",
);
assert.equal(assistantTextFromEvent({ message: { role: "assistant", content: "event message" } }), "event message");
assert.equal(
  assistantTextFromEvent({ messages: [{ role: "assistant", content: "event messages" }] }),
  "event messages",
);
assert.equal(assistantTextFromEvent({ role: "assistant", content: "direct event" }), "direct event");
assert.equal(
  workerUsageCostFromEvent({
    type: "message_end",
    assistantMessage: { role: "assistant", usage: { cost: { total: 0.0123 } } },
  }),
  0.0123,
);
assert.equal(workerUsageCostFromStats({ cost: 0.0456 }), 0.0456);
assert.equal(
  lastAssistantTextFromEvents([
    { message: { role: "assistant", content: "first event" } },
    { messages: [{ role: "assistant", content: "last event" }] },
  ]),
  "last event",
);
assert.match(buildMissingTaskResultMessage(), /TASK_RESULT:\nstatus: done\|partial\|blocked\|failed/);

class FakeWorkerSession {
  prompts: string[] = [];
  messages: unknown[] = [];
  private listeners: Array<(event: unknown) => void> = [];
  private readonly responses: string[];
  private readonly responseCosts: Array<number | undefined>;
  private readonly statsCost: number | undefined;

  constructor(responses: string[], options: { responseCosts?: Array<number | undefined>; statsCost?: number } = {}) {
    this.responses = responses;
    this.responseCosts = [...(options.responseCosts ?? [])];
    this.statsCost = options.statsCost;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const response = this.responses.shift() ?? "";
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    const cost = this.responseCosts.shift();
    const message =
      cost === undefined
        ? { role: "assistant", content: response }
        : { role: "assistant", content: response, usage: { cost: { total: cost } } };
    this.messages.push(message);
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end", message, toolResults: [] });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  getLastAssistantText(): string | undefined {
    return this.responses.length < 2 ? lastAssistantTextFromMessages(this.messages) : undefined;
  }

  getSessionStats(): unknown {
    return this.statsCost === undefined ? undefined : { cost: this.statsCost };
  }

  dispose(): void {}

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const fakeDoneSession = new FakeWorkerSession([
  `TASK_RESULT:
status: done
summary: ok
changes:
- none
verification:
- not run
remaining:
- none`,
]);
const fakeDoneOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  sessionFactory: async () => ({ session: fakeDoneSession }),
});
assert.equal(fakeDoneOutcome.reportedStatus, "done");
assert.equal(fakeDoneOutcome.done, true);
assert.equal(fakeDoneSession.prompts.length, 1);
assert.match(fakeDoneSession.prompts[0], /Assigned task: `TODO 4 — Port worker prompt and TASK_RESULT parsing`/);
assert.ok(fakeDoneOutcome.events.some((event) => event.type === "message_update" && event.textDelta));

const fakeCostSession = new FakeWorkerSession(
  [
    `TASK_RESULT:
status: done
summary: ok
changes:
- none
verification:
- not run
remaining:
- none`,
  ],
  { responseCosts: [0.0012], statsCost: 0.0012 },
);
const fakeCostOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  sessionFactory: async () => ({ session: fakeCostSession }),
});
assert.equal(fakeCostOutcome.workerCostTotal, 0.0012);
assert.equal(fakeCostOutcome.workerCostSource, "session_stats");
assert.ok(fakeCostOutcome.events.some((event) => event.type === "message_end" && event.usageCostTotal === 0.0012));

const fakeEventCostSession = new FakeWorkerSession(
  [
    `TASK_RESULT:
status: done
summary: ok
changes:
- none
verification:
- not run
remaining:
- none`,
  ],
  { responseCosts: [0.0023] },
);
const fakeEventCostOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  sessionFactory: async () => ({ session: fakeEventCostSession }),
});
assert.equal(fakeEventCostOutcome.workerCostTotal, 0.0023);
assert.equal(fakeEventCostOutcome.workerCostSource, "message_end");

const fakeMissingResultSession = new FakeWorkerSession([
  "I finished but forgot the block.",
  `TASK_RESULT:
status: partial
summary: supplied after reminder
changes:
- none
verification:
- not run
remaining:
- none`,
]);
const fakeMissingResultOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  sessionFactory: async () => ({ session: fakeMissingResultSession }),
});
assert.equal(fakeMissingResultOutcome.reportedStatus, "partial");
assert.equal(fakeMissingResultSession.prompts.length, 2);
assert.match(fakeMissingResultSession.prompts[1], /previous response did not include/);
assert.ok(
  fakeMissingResultOutcome.contextObservations.some((item) =>
    item.includes("missing TASK_RESULT status after initial prompt"),
  ),
);

const missingCredentialsOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  sessionFactory: async () => {
    throw new Error("No API credentials available for worker model");
  },
});
assert.equal(missingCredentialsOutcome.reportedStatus, "partial");
assert.equal(missingCredentialsOutcome.done, false);
assert.equal(missingCredentialsOutcome.error, "No API credentials available for worker model");
assert.match(missingCredentialsOutcome.assistantText, /Pi Long Task\/session error: No API credentials available/);
assert.equal(missingCredentialsOutcome.aborted, false);

const extensionLoaderCalls: string[] = [];
const fakeResourceLoader = {
  getExtensions() {
    extensionLoaderCalls.push("getExtensions");
    return { extensions: ["must not leak"], errors: ["must not leak"], runtime: "must not leak" };
  },
  getSkills() {
    return { skills: ["skill"], diagnostics: [] };
  },
  getPrompts() {
    return { prompts: ["prompt"], diagnostics: [] };
  },
  getThemes() {
    return { themes: ["theme"], diagnostics: [] };
  },
  getAgentsFiles() {
    return { agentsFiles: ["AGENTS.md"] };
  },
  getSystemPrompt() {
    return "system";
  },
  getAppendSystemPrompt() {
    return ["append"];
  },
  extendResources(paths: unknown) {
    extensionLoaderCalls.push(`extendResources:${String(paths)}`);
  },
  async reload() {
    extensionLoaderCalls.push("reload");
  },
};
const runtime = { runtime: true };
const isolatedLoader = disableExtensionsForWorker(fakeResourceLoader, () => runtime);
assert.deepEqual(isolatedLoader.getExtensions(), { extensions: [], errors: [], runtime });
assert.deepEqual(isolatedLoader.getSkills(), { skills: ["skill"], diagnostics: [] });
assert.deepEqual(isolatedLoader.getPrompts(), { prompts: ["prompt"], diagnostics: [] });
assert.deepEqual(isolatedLoader.getThemes(), { themes: ["theme"], diagnostics: [] });
assert.deepEqual(isolatedLoader.getAgentsFiles(), { agentsFiles: ["AGENTS.md"] });
assert.equal(isolatedLoader.getSystemPrompt(), "system");
assert.deepEqual(isolatedLoader.getAppendSystemPrompt(), ["append"]);
isolatedLoader.extendResources("extra");
await isolatedLoader.reload();
assert.deepEqual(extensionLoaderCalls, ["extendResources:extra", "reload"]);

class AbortableWorkerSession {
  prompts: string[] = [];
  messages: unknown[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  private listeners: Array<(event: unknown) => void> = [];
  private resolvePromptStarted: (() => void) | undefined;
  private resolvePrompt: (() => void) | undefined;
  readonly promptStarted = new Promise<void>((resolve) => {
    this.resolvePromptStarted = resolve;
  });

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.resolvePromptStarted?.();
    await new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.resolvePrompt?.();
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

const abortController = new AbortController();
const abortableSession = new AbortableWorkerSession();
const abortOutcomePromise = runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0,
  abortSignal: abortController.signal,
  sessionFactory: async () => ({ session: abortableSession }),
});
await abortableSession.promptStarted;
abortController.abort();
const abortOutcome = await abortOutcomePromise;
assert.equal(abortableSession.abortCalls, 1);
assert.equal(abortableSession.disposeCalls, 1);
assert.equal(abortOutcome.aborted, true);
assert.equal(abortOutcome.shutdownRequested, true);
assert.equal(abortOutcome.error, "worker session aborted by outer signal");
assert.equal(abortOutcome.reportedStatus, "partial");
assert.match(abortOutcome.assistantText, /Pi Long Task\/session error: worker session aborted by outer signal/);

class RunningBashWorkerSession {
  prompts: string[] = [];
  steers: string[] = [];
  messages: unknown[] = [];
  isBashRunning = false;
  isStreaming = false;
  abortBashCalls = 0;
  private listeners: Array<(event: unknown) => void> = [];
  private resolvePrompt: (() => void) | undefined;

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.isBashRunning = true;
    this.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 60", timeout: 60 } });
    await new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
    this.isBashRunning = false;
    const response = `TASK_RESULT:
status: partial
summary: stopped at Pi Long Task timeout
changes:
- none
verification:
- not completed
remaining:
- retry task`;
    const message = { role: "assistant", content: response };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    this.emit({ type: "turn_end", message, toolResults: [] });
    this.emit({ type: "agent_end", messages: this.messages });
    this.resolvePrompt?.();
  }

  abortBash(): void {
    this.abortBashCalls += 1;
  }

  getLastAssistantText(): string | undefined {
    return lastAssistantTextFromMessages(this.messages);
  }

  dispose(): void {}

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const runningBashSession = new RunningBashWorkerSession();
const timeoutOutcome = await runWorkerTask({
  cwd: "/tmp/project",
  todoPath: "/tmp/TODO.md",
  task,
  attempt: 1,
  commitRequested: false,
  maxBashTimeoutSeconds: 300,
  taskTimeoutSeconds: 0.001,
  gracefulShutdownSeconds: 0,
  sessionFactory: async () => ({ session: runningBashSession }),
});
assert.equal(timeoutOutcome.timedOut, true);
assert.equal(timeoutOutcome.shutdownRequested, true);
assert.equal(timeoutOutcome.aborted, false);
assert.equal(timeoutOutcome.reportedStatus, "partial");
assert.equal(runningBashSession.abortBashCalls, 1);
assert.equal(runningBashSession.steers.length, 1);
assert.match(runningBashSession.steers[0], /reached its 0s time budget/);
assert.ok(timeoutOutcome.compactionEvents.includes("aborted running bash before graceful shutdown request"));
assert.ok(timeoutOutcome.events.some((event) => event.type === "tool_execution_start" && event.toolName === "bash"));
