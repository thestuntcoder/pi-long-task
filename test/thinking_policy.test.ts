import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_THINKING_FALLBACK_LEVEL,
  classifyThinkingTask,
  resolveAdaptiveThinkingLevel,
} from "../src/thinking_policy.ts";

test("explicit thinking overrides bypass adaptive classification unchanged", () => {
  for (const explicitThinkingLevel of ["", "minimal", "xhigh", "provider-specific"]) {
    const selected = resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      taskTitle: "Delete production customer data and redesign the distributed architecture",
      explicitThinkingLevel,
      supportedThinkingLevels: ["low"],
    });

    assert.deepEqual(selected, {
      thinkingLevel: explicitThinkingLevel,
      source: "explicit",
      classification: "not_evaluated",
      signals: [],
    });
  }
});

test("straightforward planner and worker inputs select a lower supported level", () => {
  const planner = resolveAdaptiveThinkingLevel({
    taskKind: "planner",
    inputText: "Plan a simple, focused typo correction in the README.",
  });
  const worker = resolveAdaptiveThinkingLevel({
    taskKind: "worker",
    taskTitle: "Fix one documentation typo",
    taskSection: "Correct the spelling in README.md and run the focused check.",
  });

  assert.equal(planner.classification, "straightforward");
  assert.equal(planner.thinkingLevel, "low");
  assert.equal(planner.source, "adaptive");
  assert.equal(worker.classification, "straightforward");
  assert.equal(worker.thinkingLevel, "low");
  assert.equal(worker.source, "adaptive");
});

test("complex, risky, and ambiguous work retains the high fallback", () => {
  const cases = [
    {
      expected: "complex",
      inputText: "Redesign the architecture across multiple services while preserving the public API.",
    },
    {
      expected: "risky",
      inputText: "Implement a simple production database migration for encrypted customer data.",
    },
    { expected: "ambiguous", inputText: "Investigate the unknown failure and determine the best approach." },
    { expected: "ambiguous", inputText: undefined },
  ] as const;

  for (const example of cases) {
    const selected = resolveAdaptiveThinkingLevel({ taskKind: "planner", inputText: example.inputText });
    assert.equal(selected.classification, example.expected);
    assert.equal(selected.thinkingLevel, DEFAULT_THINKING_FALLBACK_LEVEL);
    assert.equal(selected.source, "fallback");
  }
});

test("risk and complexity signals take precedence over simple wording", () => {
  const classified = classifyThinkingTask({
    taskKind: "worker",
    inputText: "Make a simple, small change to payment authentication in production.",
  });

  assert.equal(classified.classification, "risky");
  assert.ok(classified.signals.includes("explicitly_straightforward"));
  assert.ok(classified.signals.includes("security_or_privacy"));
});

test("adaptive levels are bounded to recognized model capabilities", () => {
  assert.equal(
    resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Fix a simple typo.",
      supportedThinkingLevels: ["medium", "high"],
    }).thinkingLevel,
    "medium",
  );
  assert.equal(
    resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Investigate an unclear issue.",
      supportedThinkingLevels: ["minimal", "low", "medium"],
    }).thinkingLevel,
    "medium",
  );
  assert.equal(
    resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Fix a simple typo.",
      supportedThinkingLevels: ["custom"],
    }).thinkingLevel,
    "high",
  );
  assert.equal(
    resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Fix a simple typo.",
      supportedThinkingLevels: [],
      attempt: 10,
    }).thinkingLevel,
    "high",
  );
  assert.equal(
    resolveAdaptiveThinkingLevel({
      taskKind: "worker",
      inputText: "Fix a simple typo.",
      supportedThinkingLevels: ["off"],
      attempt: 10,
    }).thinkingLevel,
    "off",
  );
});

test("five or more explicit or enumerated deliverables are complex", () => {
  assert.equal(
    classifyThinkingTask({
      taskKind: "worker",
      inputText: "Create 5 separate tasks for this straightforward change.",
    }).classification,
    "complex",
  );
  assert.equal(
    classifyThinkingTask({
      taskKind: "planner",
      inputText: "Plan:\n1. API\n2. Storage\n3. UI\n4. Tests\n5. Documentation",
    }).classification,
    "complex",
  );
});

test("routine worker Status and Verify checklists do not imply complex scope", () => {
  const selected = resolveAdaptiveThinkingLevel({
    taskKind: "worker",
    taskTitle: "Fix a simple README typo",
    taskSection: `**Status:**
- [ ] Find the typo.
- [ ] Correct it.
- [ ] Check formatting.

**Verify:**
- Run formatting.
- Read the result.`,
  });

  assert.equal(selected.classification, "straightforward");
  assert.equal(selected.thinkingLevel, "low");
});
