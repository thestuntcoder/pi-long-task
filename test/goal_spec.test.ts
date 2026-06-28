import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createGoalSpecification,
  goalSpecificationToMarkdown,
  validateGoalSpecification,
  type GoalSpecification,
} from "../src/goal_spec.ts";
import { GOAL_SPEC_FILE, GoalStateStore } from "../src/goal_state.ts";

const baseTime = new Date("2026-06-27T12:00:00.000Z");

const spec = createGoalSpecification({
  goalRunId: "goal-spec-test",
  originalGoal: "Build a team dashboard for engineering managers",
  summary: "Define and deliver a dashboard for engineering manager visibility.",
  now: () => baseTime,
  traceability: {
    source: "discovery_consolidation",
    sourceArtifacts: [{ label: "Product owner notes", path: "/tmp/product-notes.md" }],
  },
  scopedRequirements: {
    inScope: [
      {
        id: "REQ-1",
        title: "Dashboard overview",
        description: "Show active teams, delivery health, and blockers in one view.",
        priority: "must",
        acceptanceCriterionIds: ["AC-1"],
        milestoneIds: ["MS-1"],
        source: "Product owner",
      },
    ],
    outOfScope: [
      {
        id: "REQ-OOS-1",
        title: "Payroll analytics",
        description: "Do not include compensation or payroll reporting.",
        priority: "wont",
        acceptanceCriterionIds: [],
        milestoneIds: [],
      },
    ],
    assumptions: ["Existing project data is available through the app API."],
    openQuestions: ["Which exact blocker severity labels should ship first?"],
  },
  milestones: [
    {
      id: "MS-1",
      title: "Usable dashboard slice",
      description: "A first dashboard page renders data and empty states.",
      requirementIds: ["REQ-1"],
      acceptanceCriterionIds: ["AC-1"],
      doneWhen: ["Dashboard route renders with API-backed data."],
    },
  ],
  acceptanceCriteria: [
    {
      id: "AC-1",
      description: "Engineering managers can see active teams and blockers without navigating away.",
      requirementIds: ["REQ-1"],
      verificationGateIds: ["VG-1"],
    },
  ],
  verificationGates: [
    {
      id: "VG-1",
      title: "Focused test suite",
      description: "Run focused dashboard tests.",
      required: true,
      command: "npm test -- dashboard",
      successCriteria: ["All dashboard tests pass."],
    },
  ],
  designConstraints: {
    uxPrinciples: ["Prioritize scannability for busy managers."],
    uiRequirements: ["Use existing application components."],
    accessibility: ["Dashboard cards must have descriptive headings."],
    architecturalConstraints: ["Avoid introducing a new client-side state library."],
    constraints: [
      {
        id: "DC-1",
        title: "Existing visual system",
        description: "Use existing spacing, color, and typography tokens.",
      },
    ],
  },
  productConstraints: {
    targetUsers: ["Engineering managers"],
    platforms: ["Web app"],
    businessRules: ["Do not expose confidential compensation data."],
    compliance: ["Respect existing authorization rules."],
    dependencies: ["Existing team/project API"],
    risks: ["Incomplete API data could make health indicators misleading."],
    constraints: [
      {
        id: "PC-1",
        title: "Authorization",
        description: "Only show teams the current user is allowed to view.",
      },
    ],
  },
  marketingGrowthContext: {
    targetSegments: ["Engineering leadership"],
    positioning: ["Operational visibility without heavyweight reporting setup."],
    acquisitionChannels: ["In-app announcement"],
    growthMetrics: ["Weekly dashboard views"],
    launchConsiderations: ["Announce after the first verified manager workflow ships."],
  },
  definitionOfDone: {
    summary: "The dashboard is done when REQ-1 and AC-1 are satisfied and VG-1 passes.",
    requirementIds: ["REQ-1"],
    acceptanceCriterionIds: ["AC-1"],
    verificationGateIds: ["VG-1"],
    requiredArtifacts: ["Implementation TODO results", "Verification output"],
    notes: ["Original vague goal remains available through traceability."],
  },
});

assert.equal(spec.schemaVersion, 1);
assert.equal(spec.originalGoal, "Build a team dashboard for engineering managers");
assert.equal(spec.traceability.originalUserGoal, spec.originalGoal);
assert.equal(spec.traceability.goalRunId, spec.goalRunId);
assert.equal(spec.scopedRequirements.inScope[0]?.id, "REQ-1");
assert.equal(spec.definitionOfDone.verificationGateIds[0], "VG-1");
assert.equal(validateGoalSpecification(spec), spec);

const markdown = goalSpecificationToMarkdown(spec);
assert.match(markdown, /Persisted goal specification/);
assert.match(markdown, /Original user goal: Build a team dashboard/);
assert.match(markdown, /REQ-1 \(must\): Dashboard overview/);
assert.match(markdown, /VG-1 \(required\): Focused test suite/);
assert.match(markdown, /Marketing\/growth context/);
assert.match(markdown, /Definition of done/);

assert.throws(
  () =>
    validateGoalSpecification({
      ...spec,
      traceability: { ...spec.traceability, originalUserGoal: "different goal" },
    } satisfies GoalSpecification),
  /traceability\.originalUserGoal must match originalGoal/,
);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-goal-spec-test-"));
try {
  const store = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-spec-test" });
  assert.equal(path.basename(store.paths.goalSpecPath), GOAL_SPEC_FILE);
  assert.equal(await store.tryLoadGoalSpecification(), undefined);

  await store.saveGoalSpecification(spec);

  const storedText = await readFile(store.paths.goalSpecPath, "utf8");
  assert.match(storedText, /"schemaVersion": 1/);
  assert.match(storedText, /"definitionOfDone"/);

  const loaded = await store.loadGoalSpecification();
  assert.deepEqual(loaded, spec);

  const restartedStore = new GoalStateStore({ cwd: tempRoot, goalRunId: "goal-spec-test" });
  const reloaded = await restartedStore.loadGoalSpecification();
  assert.deepEqual(reloaded, spec);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
