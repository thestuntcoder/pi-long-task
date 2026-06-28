import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { classifyGoalForDiscovery, decideGoalDiscovery, runDefaultGoalDiscovery } from "../src/goal_discovery.ts";
import { createGoalLoopState } from "../src/goal_loop.ts";
import { GoalStateStore } from "../src/goal_state.ts";

const vagueDecision = decideGoalDiscovery({ goal: "Build a team dashboard" });
assert.equal(vagueDecision.classification, "vague");
assert.equal(vagueDecision.route, "discovery");
assert.match(vagueDecision.reason, /define scope/i);
assert.ok(vagueDecision.vagueSignals.length > 0);

const concreteDecision = decideGoalDiscovery({
  goal: "Update src/goal_loop.ts to add maxIterations validation, add tests in test/goal_loop.test.ts, and run npm test -- goal_loop.",
});
assert.equal(concreteDecision.classification, "concrete");
assert.equal(concreteDecision.route, "direct");
assert.ok(concreteDecision.concreteSignals.includes("file or path reference"));
assert.ok(concreteDecision.concreteSignals.includes("test or verification command"));

const longTaskDecision = decideGoalDiscovery({ goal: "Build a team dashboard", entrypoint: "pi_long_task" });
assert.equal(longTaskDecision.classification, "vague");
assert.equal(longTaskDecision.route, "direct");
assert.match(longTaskDecision.reason, /pi_long_task keeps direct/i);

const explicitDiscovery = classifyGoalForDiscovery("Discover requirements for a customer onboarding portal");
assert.equal(explicitDiscovery.classification, "vague");
assert.ok(explicitDiscovery.vagueSignals.includes("explicit discovery/planning request"));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-discovery-test-"));
try {
  const state = createGoalLoopState({
    goal: "Build a customer onboarding portal",
    cwd: tempRoot,
    goalRunId: "goal-discovery-workflow",
    now: () => new Date("2026-06-27T13:00:00.000Z"),
  });
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });
  const spec = await runDefaultGoalDiscovery({
    state,
    store,
    decision: vagueDecision,
    now: () => new Date("2026-06-27T13:05:00.000Z"),
  });

  assert.equal(spec.traceability.source, "discovery_consolidation");
  assert.equal(spec.discovery?.roleOutputs.length, 6);
  assert.deepEqual(
    spec.discovery?.roleOutputs.map((output) => output.role),
    [
      "product_owner",
      "project_manager",
      "software_architect_tech_lead",
      "ux_ui_designer",
      "qa_reviewer",
      "marketing_growth",
    ],
  );
  assert.ok(spec.scopedRequirements.inScope.length >= 6);
  assert.ok(spec.scopedRequirements.outOfScope.length > 0);
  assert.ok(spec.milestones.length >= 3);
  assert.ok(spec.acceptanceCriteria.length >= 6);
  assert.ok(spec.verificationGates.some((gate) => gate.required));
  assert.ok(spec.designConstraints.uxPrinciples.length > 0);
  assert.ok(spec.designConstraints.accessibility.length > 0);
  assert.ok(spec.productConstraints.targetUsers.length > 0);
  assert.ok(spec.productConstraints.risks.length > 0);
  assert.ok(spec.marketingGrowthContext?.positioning.length);
  assert.ok(spec.definitionOfDone.requiredArtifacts.some((artifact) => /GOAL_SPEC/.test(artifact)));

  await store.saveGoalSpecification(spec);
  const persisted = await store.loadGoalSpecification();
  assert.deepEqual(persisted, spec);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
