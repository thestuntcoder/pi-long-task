import assert from "node:assert/strict";

import { addWorkerCostToAssistantMessage, createWorkerCostAccumulator } from "../src/index.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "parent response" }],
    api: "openai-chat-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037,
      },
    },
    stopReason: "stop",
    timestamp: 123,
  };
}

const original = assistantMessage();
const patched = addWorkerCostToAssistantMessage(original, 0.125);
assert.ok(patched);
assert.equal(patched.usage.cost.total, 0.162);
assert.deepEqual(
  {
    input: patched.usage.input,
    output: patched.usage.output,
    cacheRead: patched.usage.cacheRead,
    cacheWrite: patched.usage.cacheWrite,
    totalTokens: patched.usage.totalTokens,
  },
  {
    input: original.usage.input,
    output: original.usage.output,
    cacheRead: original.usage.cacheRead,
    cacheWrite: original.usage.cacheWrite,
    totalTokens: original.usage.totalTokens,
  },
);
assert.deepEqual(
  {
    input: patched.usage.cost.input,
    output: patched.usage.cost.output,
    cacheRead: patched.usage.cost.cacheRead,
    cacheWrite: patched.usage.cost.cacheWrite,
  },
  {
    input: original.usage.cost.input,
    output: original.usage.cost.output,
    cacheRead: original.usage.cost.cacheRead,
    cacheWrite: original.usage.cost.cacheWrite,
  },
);

const accumulator = createWorkerCostAccumulator();
assert.equal(accumulator.applyToAssistantMessage(assistantMessage()), undefined);
accumulator.add(0.05);
accumulator.add(Number.NaN);
accumulator.add(-1);
const first = accumulator.applyToAssistantMessage(assistantMessage());
assert.ok(first);
assert.equal(first.usage.cost.total, 0.087);
assert.equal(accumulator.applyToAssistantMessage(assistantMessage()), undefined);
