import assert from "node:assert/strict";

import { runGuardedSessionPrompt } from "../src/session_guard.ts";
import { lastAssistantTextFromMessages } from "../src/worker_session.ts";

class GuardedFakeSession {
  prompts: string[] = [];
  followUps: string[] = [];
  messages: unknown[] = [];
  disposeCalls = 0;
  sessionFile = "/tmp/session.json";
  sessionId = "session-1";
  private listeners: Array<(event: unknown) => void> = [];

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.emitAssistantText("guarded response");
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
    this.emitAssistantText("follow-up response");
  }

  getLastAssistantText(): string | undefined {
    return lastAssistantTextFromMessages(this.messages);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  private emitAssistantText(text: string): void {
    const message = { role: "assistant", content: text };
    this.messages.push(message);
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const successSession = new GuardedFakeSession();
const seenEvents: unknown[] = [];
const success = await runGuardedSessionPrompt({
  session: successSession,
  prompt: "hello",
  timeoutMs: 0,
  diagnostics: ["created fake session"],
  onEvent: (event) => seenEvents.push(event),
});
assert.equal(success.assistantText, "guarded response");
assert.equal(success.timedOut, false);
assert.equal(success.aborted, false);
assert.equal(success.error, undefined);
assert.deepEqual(success.diagnostics, ["created fake session"]);
assert.equal(successSession.disposeCalls, 1);
assert.equal(successSession.prompts.length, 1);
assert.equal(success.sessionFile, "/tmp/session.json");
assert.equal(success.sessionId, "session-1");
assert.ok(success.events.length > 0);
assert.equal(seenEvents.length, success.events.length);

class HangingSession extends GuardedFakeSession {
  abortCalls = 0;
  resolvePrompt: (() => void) | undefined;
  private resolvePromptStarted: (() => void) | undefined;
  readonly promptStarted = new Promise<void>((resolve) => {
    this.resolvePromptStarted = resolve;
  });

  override async prompt(text: string): Promise<void> {
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
}

const timeoutSession = new HangingSession();
const timeoutPromise = runGuardedSessionPrompt({
  session: timeoutSession,
  prompt: "hang",
  timeoutMs: 10,
  gracefulShutdownMs: 10,
  gracefulShutdownPrompt: "please stop",
});
await timeoutSession.promptStarted;
const timeout = await timeoutPromise;
assert.equal(timeout.timedOut, true);
assert.equal(timeout.aborted, true);
assert.match(timeout.error ?? "", /exceeded 0\.010s timeout/);
assert.equal(timeoutSession.abortCalls, 1);
assert.equal(timeoutSession.followUps.length, 1);
assert.equal(timeoutSession.disposeCalls, 1);
assert.ok(timeout.diagnostics.some((item) => item.includes("timed out after 0.010s")));

const abortController = new AbortController();
const abortSession = new HangingSession();
const abortPromise = runGuardedSessionPrompt({
  session: abortSession,
  prompt: "hang until abort",
  abortSignal: abortController.signal,
  timeoutMs: 0,
});
await abortSession.promptStarted;
abortController.abort(new Error("outer abort"));
const aborted = await abortPromise;
assert.equal(aborted.timedOut, false);
assert.equal(aborted.aborted, true);
assert.equal(aborted.error, "outer abort");
assert.equal(abortSession.abortCalls, 1);
assert.equal(abortSession.disposeCalls, 1);

const preAbortController = new AbortController();
preAbortController.abort("pre-aborted");
const preAbortSession = new GuardedFakeSession();
const preAborted = await runGuardedSessionPrompt({
  session: preAbortSession,
  prompt: "must not run",
  abortSignal: preAbortController.signal,
});
assert.equal(preAborted.aborted, true);
assert.equal(preAborted.error, "pre-aborted");
assert.equal(preAbortSession.prompts.length, 0);
assert.equal(preAbortSession.disposeCalls, 1);

class FailingPromptSession extends GuardedFakeSession {
  override async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    throw new Error("prompt failed");
  }
}

const failingSession = new FailingPromptSession();
const failed = await runGuardedSessionPrompt({
  session: failingSession,
  prompt: "fail",
});
assert.equal(failed.error, "prompt failed");
assert.equal(failingSession.disposeCalls, 1);
