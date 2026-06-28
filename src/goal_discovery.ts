import {
  createGoalSpecification,
  type GoalAcceptanceCriterion,
  type GoalDefinitionOfDone,
  type GoalDesignConstraints,
  type GoalDiscoveryConsolidation,
  type GoalMarketingGrowthContext,
  type GoalMilestone,
  type GoalProductConstraints,
  type GoalScopedRequirements,
  type GoalSpecification,
  type GoalVerificationGate,
} from "./goal_spec.ts";
import type { GoalLoopState } from "./goal_loop.ts";
import type { GoalStateStore } from "./goal_state.ts";

export type GoalDiscoveryEntrypoint = "pi_goal_task" | "pi_long_task";
export type GoalDiscoveryRoute = "discovery" | "direct";
export type GoalConcreteness = "vague" | "concrete";

export interface GoalDiscoveryDecision {
  route: GoalDiscoveryRoute;
  classification: GoalConcreteness;
  confidence: number;
  concreteSignals: string[];
  vagueSignals: string[];
  reason: string;
}

export interface DecideGoalDiscoveryOptions {
  goal: string;
  entrypoint?: GoalDiscoveryEntrypoint;
}

export interface GoalDiscoveryRunnerOptions {
  state: GoalLoopState;
  store: GoalStateStore;
  decision: GoalDiscoveryDecision;
  cwd?: string;
  abortSignal?: AbortSignal;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  now: () => Date;
}

export type GoalDiscoveryRunner = (options: GoalDiscoveryRunnerOptions) => Promise<GoalSpecification>;

export function decideGoalDiscovery(options: DecideGoalDiscoveryOptions): GoalDiscoveryDecision {
  const entrypoint = options.entrypoint ?? "pi_goal_task";
  const goal = options.goal.trim();
  const classification = classifyGoalForDiscovery(goal);

  if (entrypoint !== "pi_goal_task") {
    return {
      ...classification,
      route: "direct",
      reason: "Discovery is only enabled by default for pi_goal_task; pi_long_task keeps direct long-task behavior.",
    };
  }

  if (classification.classification === "vague") {
    return {
      ...classification,
      route: "discovery",
      reason:
        "Goal is vague enough that pi_goal_task should define scope and definition-of-done before implementation.",
    };
  }

  return {
    ...classification,
    route: "direct",
    reason:
      "Goal already contains concrete implementation or verification detail, so existing TODO generation is preserved.",
  };
}

export function classifyGoalForDiscovery(goal: string): Omit<GoalDiscoveryDecision, "route" | "reason"> {
  const normalized = goal.toLowerCase().replace(/\s+/g, " ").trim();
  const words = normalized.match(/[a-z0-9_./:-]+/g) ?? [];
  const concreteSignals = concreteGoalSignals(goal, normalized);
  const vagueSignals = vagueGoalSignals(normalized, words.length);

  if (explicitDiscoveryRequested(normalized)) {
    vagueSignals.push("explicit discovery/planning request");
  }

  const concreteScore = concreteSignals.length;
  const vagueScore = vagueSignals.length;
  const hasStrongConcreteSignal = concreteSignals.some((signal) =>
    ["file or path reference", "test or verification command", "explicit acceptance or verification criteria"].includes(
      signal,
    ),
  );
  const classification: GoalConcreteness =
    explicitDiscoveryRequested(normalized) ||
    (!hasStrongConcreteSignal &&
      (vagueScore > concreteScore || words.length <= 6 || (concreteScore === 0 && words.length <= 12)))
      ? "vague"
      : "concrete";
  const signalTotal = Math.max(1, concreteScore + vagueScore);
  const confidence =
    classification === "vague"
      ? Math.min(1, Math.max(0.55, vagueScore / signalTotal))
      : Math.min(1, Math.max(0.55, concreteScore / signalTotal));

  return {
    classification,
    confidence: Number(confidence.toFixed(2)),
    concreteSignals,
    vagueSignals,
  };
}

export async function runDefaultGoalDiscovery(options: GoalDiscoveryRunnerOptions): Promise<GoalSpecification> {
  throwIfAborted(options.abortSignal);
  const goal = options.state.goal.trim();
  const requirementIds = ["REQ-1", "REQ-2", "REQ-3", "REQ-4", "REQ-5", "REQ-6"];
  const acceptanceCriterionIds = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"];
  const requiredGateIds = ["VG-1", "VG-2", "VG-3", "VG-4"];

  const scopedRequirements = buildScopedRequirements(goal);
  const milestones = buildMilestones();
  const acceptanceCriteria = buildAcceptanceCriteria(goal);
  const verificationGates = buildVerificationGates(goal);
  const designConstraints = buildDesignConstraints(goal);
  const productConstraints = buildProductConstraints(goal);
  const marketingGrowthContext = buildMarketingGrowthContext(goal);
  const discovery = buildDiscoveryConsolidation(goal);
  const definitionOfDone = buildDefinitionOfDone(requirementIds, acceptanceCriterionIds, requiredGateIds);

  return createGoalSpecification({
    goalRunId: options.state.goalRunId,
    originalGoal: goal,
    summary: `Software product discovery converted the vague goal into a scoped delivery definition: ${goal}`,
    now: options.now,
    traceability: {
      source: "discovery_consolidation",
      sourceArtifacts: [
        {
          label: "Original vague pi_goal_task goal",
          description: goal,
        },
        {
          label: "Role-based software product discovery consolidation",
          description:
            "Product Owner, Project Manager, Software Architect/Tech Lead, UX/UI Designer, QA/Reviewer, and optional Marketing/Growth planning outputs were consolidated into this specification.",
        },
      ],
    },
    discovery,
    scopedRequirements,
    milestones,
    acceptanceCriteria,
    verificationGates,
    designConstraints,
    productConstraints,
    marketingGrowthContext,
    definitionOfDone,
  });
}

function buildScopedRequirements(goal: string): GoalScopedRequirements {
  return {
    inScope: [
      {
        id: "REQ-1",
        title: "Primary product outcome",
        description: `Define and deliver the complete scoped software/product outcome described by the user goal: ${goal}`,
        priority: "must",
        acceptanceCriterionIds: ["AC-1", "AC-2"],
        milestoneIds: ["MS-1", "MS-2"],
        source: "Product Owner",
      },
      {
        id: "REQ-2",
        title: "Delivery milestones and sequencing",
        description:
          "Plan implementation as sequenced milestones with explicit dependencies, handoffs, and completion signals before worker TODOs begin.",
        priority: "must",
        acceptanceCriterionIds: ["AC-2"],
        milestoneIds: ["MS-1"],
        source: "Project Manager",
      },
      {
        id: "REQ-3",
        title: "Technical approach and integration constraints",
        description:
          "Use the existing codebase architecture and extension boundaries, preserving current pi_long_task behavior and concrete pi_goal_task behavior unless scope explicitly requires otherwise.",
        priority: "must",
        acceptanceCriterionIds: ["AC-4"],
        milestoneIds: ["MS-2"],
        source: "Software Architect/Tech Lead",
      },
      {
        id: "REQ-4",
        title: "User experience and accessibility constraints",
        description:
          "Define the primary workflow, user-facing states, accessible interaction expectations, and design constraints needed for a usable product result.",
        priority: "should",
        acceptanceCriterionIds: ["AC-3"],
        milestoneIds: ["MS-1", "MS-2"],
        source: "UX/UI Designer",
      },
      {
        id: "REQ-5",
        title: "Quality, review, and verification readiness",
        description:
          "Establish acceptance criteria, required verification gates, and review evidence before implementation is planned.",
        priority: "must",
        acceptanceCriterionIds: ["AC-5"],
        milestoneIds: ["MS-3"],
        source: "QA/Reviewer",
      },
      {
        id: "REQ-6",
        title: "Launch and growth context",
        description:
          "Capture lightweight marketing, positioning, launch, and success-metric context when the goal represents a user-facing product or feature.",
        priority: "could",
        acceptanceCriterionIds: ["AC-6"],
        milestoneIds: ["MS-3"],
        source: "Marketing/Growth",
      },
    ],
    outOfScope: [
      {
        id: "OOS-1",
        title: "Unvalidated expansion beyond discovered scope",
        description:
          "Do not add unrelated features, broad rewrites, or speculative enhancements that are not required by the scoped requirements.",
        priority: "wont",
        acceptanceCriterionIds: [],
        milestoneIds: [],
        source: "Discovery consolidation",
      },
      {
        id: "OOS-2",
        title: "Full launch campaign execution",
        description:
          "Do not execute marketing campaigns, analytics rollouts, or external communications unless they become explicit implementation tasks later.",
        priority: "wont",
        acceptanceCriterionIds: [],
        milestoneIds: [],
        source: "Marketing/Growth",
      },
    ],
    assumptions: [
      "The goal is a software/product delivery goal that needs product definition before implementation planning.",
      "Automated discovery cannot interview stakeholders, so unresolved stakeholder decisions are preserved as open questions.",
      "Implementation workers should use this persisted specification as the definition-of-done instead of relying only on the original vague goal.",
    ],
    openQuestions: [
      "Who are the primary and secondary users, and what job-to-be-done should the complete scoped product satisfy?",
      "Which repository areas, platforms, integrations, or external services constrain the implementation?",
      "What measurable product or operational signal proves the delivered slice is successful?",
      "Which non-goals or edge cases must remain out of scope for this goal-oriented delivery?",
    ],
  };
}

function buildMilestones(): GoalMilestone[] {
  return [
    {
      id: "MS-1",
      title: "Product definition and delivery plan",
      description:
        "Consolidate role planning into scoped requirements, acceptance criteria, verification gates, and constraints.",
      requirementIds: ["REQ-1", "REQ-2", "REQ-4"],
      acceptanceCriterionIds: ["AC-1", "AC-2", "AC-3"],
      doneWhen: [
        "The persisted specification names in-scope and out-of-scope work.",
        "Milestones, acceptance criteria, and verification gates are available for TODO generation and review.",
      ],
    },
    {
      id: "MS-2",
      title: "Implementable technical and UX slice",
      description: "Generate and execute implementation TODOs that deliver the scoped product outcome safely.",
      requirementIds: ["REQ-1", "REQ-3", "REQ-4"],
      acceptanceCriterionIds: ["AC-1", "AC-3", "AC-4"],
      doneWhen: [
        "Implementation work traces to requirement IDs and acceptance criteria.",
        "Technical and UX constraints are respected by the implementation plan.",
      ],
    },
    {
      id: "MS-3",
      title: "Verification, review, and readiness",
      description: "Collect verification evidence and review completion against the persisted definition-of-done.",
      requirementIds: ["REQ-5", "REQ-6"],
      acceptanceCriterionIds: ["AC-5", "AC-6"],
      doneWhen: [
        "Required verification gates pass or record justified blockers.",
        "Reviewer evaluation references the persisted specification and any remaining work.",
      ],
    },
  ];
}

function buildAcceptanceCriteria(goal: string): GoalAcceptanceCriterion[] {
  return [
    {
      id: "AC-1",
      description: `The delivered software/product slice demonstrably addresses the primary user outcome implied by: ${goal}`,
      requirementIds: ["REQ-1"],
      verificationGateIds: ["VG-1", "VG-3"],
    },
    {
      id: "AC-2",
      description:
        "Implementation TODOs and review evidence can be traced back to requirements, milestones, constraints, and definition-of-done IDs in this specification.",
      requirementIds: ["REQ-1", "REQ-2"],
      verificationGateIds: ["VG-1", "VG-4"],
    },
    {
      id: "AC-3",
      description:
        "Primary user workflows, empty/error states where relevant, accessibility expectations, and design constraints are considered before the feature is marked complete.",
      requirementIds: ["REQ-4"],
      verificationGateIds: ["VG-3"],
    },
    {
      id: "AC-4",
      description:
        "The implementation fits existing architecture, minimizes unrelated change, and preserves current pi_long_task behavior plus concrete pi_goal_task behavior.",
      requirementIds: ["REQ-3"],
      verificationGateIds: ["VG-2", "VG-4"],
    },
    {
      id: "AC-5",
      description:
        "Required tests, focused checks, or manual verification evidence are recorded, and blockers are explicit if a gate cannot be run.",
      requirementIds: ["REQ-5"],
      verificationGateIds: ["VG-2", "VG-4"],
    },
    {
      id: "AC-6",
      description:
        "Relevant launch, positioning, target segment, and growth metric context is available or explicitly deemed unnecessary for the scoped goal.",
      requirementIds: ["REQ-6"],
      verificationGateIds: ["VG-5"],
    },
  ];
}

function buildVerificationGates(goal: string): GoalVerificationGate[] {
  return [
    {
      id: "VG-1",
      title: "Specification persistence and traceability review",
      description: "Confirm the software discovery specification is saved and used as downstream context.",
      required: true,
      successCriteria: [
        "GOAL_SPEC.json exists for this pi_goal_task run.",
        "The specification includes scoped requirements, milestones, acceptance criteria, verification gates, design constraints, product constraints, and definition-of-done.",
        `The original vague goal remains traceable: ${goal}`,
      ],
    },
    {
      id: "VG-2",
      title: "Focused technical verification",
      description:
        "Run the most relevant project checks for the implementation slice, such as targeted tests, typechecking, linting, or smoke checks.",
      required: true,
      successCriteria: [
        "Focused verification commands pass, or an explicit blocker explains why they could not be run.",
        "Verification output is referenced in worker or reviewer results.",
      ],
    },
    {
      id: "VG-3",
      title: "Product and UX acceptance review",
      description:
        "Review the implemented slice against primary workflow, usability, accessibility, and design constraints.",
      required: true,
      successCriteria: [
        "The primary user outcome is satisfied by observable behavior or documented implementation evidence.",
        "Relevant accessibility and UX states are handled or explicitly scoped out.",
      ],
    },
    {
      id: "VG-4",
      title: "Architecture and regression review",
      description:
        "Confirm the solution is maintainable, scoped, and does not regress existing extension/task behavior.",
      required: true,
      successCriteria: [
        "Changes are limited to the implementation scope described by the persisted specification.",
        "Existing pi_long_task behavior and concrete pi_goal_task behavior remain stable unless explicitly changed.",
      ],
    },
    {
      id: "VG-5",
      title: "Launch/growth readiness check",
      description: "For user-facing work, confirm positioning, target segment, and success metric notes are captured.",
      required: false,
      successCriteria: [
        "Marketing/growth context is present for user-facing product work.",
        "If not relevant, the reviewer can explain why this optional gate is unnecessary.",
      ],
    },
  ];
}

function buildDesignConstraints(goal: string): GoalDesignConstraints {
  return {
    uxPrinciples: [
      "Optimize for the primary user workflow before secondary or administrative flows.",
      "Prefer clear, reversible, and observable interactions over hidden automation.",
      "Keep UX states explicit enough for implementation workers to verify without stakeholder interviews.",
    ],
    uiRequirements: [
      `Any user-facing UI for '${goal}' should use existing project components, layout conventions, and content tone where available.`,
      "Represent loading, empty, error, and success states when the feature has asynchronous or data-dependent behavior.",
      "Avoid introducing a new visual system unless explicitly required by the generated implementation TODOs.",
    ],
    accessibility: [
      "Interactive controls need accessible names, keyboard-operable behavior, and visible focus where applicable.",
      "User-facing status, error, and completion messages should be perceivable without relying on color alone.",
    ],
    architecturalConstraints: [
      "Preserve pi_long_task behavior and the direct path for already-concrete pi_goal_task goals.",
      "Use existing repository patterns before introducing new dependencies, frameworks, services, or state-management layers.",
      "Keep TODO generation, execution, and review boundaries explicit so downstream workers can operate independently.",
    ],
    constraints: [
      {
        id: "DC-1",
        title: "Existing design system first",
        description: "Reuse established spacing, typography, color, and component conventions from the repository.",
      },
      {
        id: "DC-2",
        title: "Accessible scoped product",
        description:
          "Do not mark user-facing work complete without considering keyboard, screen-reader, and contrast needs.",
      },
      {
        id: "DC-3",
        title: "Minimal architectural footprint",
        description: "Prefer small, cohesive changes that are easy for reviewers to trace to this specification.",
      },
    ],
  };
}

function buildProductConstraints(goal: string): GoalProductConstraints {
  return {
    targetUsers: [
      `Primary users or operators who need the outcome described by: ${goal}`,
      "Implementation and review workers who need a concrete definition-of-done for the goal loop.",
    ],
    platforms: [
      "Existing software platform and repository surfaces implied by the goal.",
      "Pi goal-task orchestration artifacts under the run directory.",
    ],
    businessRules: [
      "All behavior required to satisfy the scoped goal should be implemented, while unrelated expansion stays out of scope.",
      "Out-of-scope enhancements require a later goal or explicit stakeholder decision",
    ],
    compliance: [
      "Respect existing authorization, privacy, data-retention, and safety constraints present in the repository.",
      "Do not expose secrets, credentials, private user data, or internal paths in user-facing output unless already standard for the project.",
    ],
    dependencies: [
      "Existing codebase APIs, tests, build tooling, and extension integration points.",
      "Persisted goal specification availability for downstream TODO generation and review.",
    ],
    risks: [
      "The original goal is vague; implementation may overbuild without the persisted scope and non-goals.",
      "Missing stakeholder details may leave open questions that should be converted into safe assumptions or blockers.",
      "Skipping verification gates may produce a result that appears complete but fails product or regression expectations.",
    ],
    constraints: [
      {
        id: "PC-1",
        title: "Scoped full-goal delivery",
        description:
          "Deliver the complete scoped goal rather than downgrading broad user intent to an MVP or speculative roadmap.",
      },
      {
        id: "PC-2",
        title: "Traceable definition-of-done",
        description: "Completion must be judged against persisted requirements, acceptance criteria, and gates.",
      },
      {
        id: "PC-3",
        title: "Behavior compatibility",
        description: "Avoid regressions to existing task orchestration unless explicitly required by the scope.",
      },
    ],
  };
}

function buildMarketingGrowthContext(goal: string): GoalMarketingGrowthContext {
  return {
    targetSegments: [
      `Users, teams, or operators whose workflow improves when '${goal}' is delivered.`,
      "Early internal adopters or reviewers who can validate the delivered scoped product.",
    ],
    positioning: [
      "A scoped software product outcome with clear user value and reviewable definition-of-done.",
      "Avoid downgrading explicit user intent to a partial MVP unless the user asked for an MVP.",
    ],
    acquisitionChannels: [
      "Release notes, README/update documentation, in-app messaging, or internal handoff notes as appropriate.",
    ],
    growthMetrics: [
      "Primary workflow completion or adoption for the delivered feature.",
      "Reduction in manual clarification needed before implementation and review.",
    ],
    launchConsiderations: [
      "Document any user-facing behavior changes, migration notes, or follow-up decisions before broad release.",
      "Treat external launch execution as out of scope unless a future implementation TODO makes it explicit.",
    ],
  };
}

function buildDiscoveryConsolidation(goal: string): GoalDiscoveryConsolidation {
  return {
    approach:
      "Structured software product discovery with role-specific planning outputs, consolidated into implementation-ready requirements rather than generic brainstorming.",
    roleOutputs: [
      {
        role: "product_owner",
        title: "Product Owner",
        objective:
          "Define user value, full scoped product requirements, non-goals, and product acceptance for the vague goal.",
        findings: [
          `The goal '${goal}' needs a primary user outcome before implementation begins.`,
          "Scope should preserve explicit user requirements as mandatory and clarify any unresolved stakeholder questions.",
        ],
        decisions: [
          "Use REQ-1 as the core product outcome and AC-1 as the primary acceptance criterion.",
          "Keep speculative expansion in OOS-1 unless future goals explicitly add it.",
        ],
        risks: ["Implementation may overbuild if product non-goals are ignored."],
        requirementIds: ["REQ-1", "REQ-6"],
        milestoneIds: ["MS-1", "MS-2"],
        acceptanceCriterionIds: ["AC-1", "AC-2", "AC-6"],
        verificationGateIds: ["VG-1", "VG-3", "VG-5"],
        constraintIds: ["PC-1", "PC-2"],
      },
      {
        role: "project_manager",
        title: "Project Manager",
        objective: "Sequence delivery into milestones with dependencies, handoffs, and readiness gates.",
        findings: [
          "The work needs definition, implementation, and verification milestones before task workers start.",
          "Downstream TODOs should be independently assignable and traceable to persisted IDs.",
        ],
        decisions: [
          "Use MS-1 for planning, MS-2 for implementation, and MS-3 for verification/readiness.",
          "Require verification evidence before marking the goal complete.",
        ],
        risks: ["Skipping sequencing may create TODOs that mix planning, implementation, and review responsibilities."],
        requirementIds: ["REQ-2", "REQ-5"],
        milestoneIds: ["MS-1", "MS-2", "MS-3"],
        acceptanceCriterionIds: ["AC-2", "AC-5"],
        verificationGateIds: ["VG-1", "VG-2", "VG-4"],
        constraintIds: ["PC-2"],
      },
      {
        role: "software_architect_tech_lead",
        title: "Software Architect/Tech Lead",
        objective:
          "Define implementation boundaries, architecture compatibility, and technical verification expectations.",
        findings: [
          "The implementation plan must fit existing repository structure and preserve stable task behavior.",
          "Technical verification should be selected from the project tooling available to workers.",
        ],
        decisions: [
          "Use REQ-3 and AC-4 to constrain technical design.",
          "Make architecture/regression review a required gate.",
        ],
        risks: ["New dependencies or rewrites could exceed the scoped product requirements."],
        requirementIds: ["REQ-3"],
        milestoneIds: ["MS-2"],
        acceptanceCriterionIds: ["AC-4", "AC-5"],
        verificationGateIds: ["VG-2", "VG-4"],
        constraintIds: ["DC-3", "PC-3"],
      },
      {
        role: "ux_ui_designer",
        title: "UX/UI Designer",
        objective:
          "Translate vague product intent into workflow, UI state, accessibility, and design-system constraints.",
        findings: [
          "User-facing work needs explicit workflow states and accessibility expectations.",
          "Existing design conventions should guide product UI unless the discovered requirements call for a new visual direction.",
        ],
        decisions: [
          "Use REQ-4 and AC-3 to keep UX/design review in scope.",
          "Record design constraints DC-1 and DC-2 for downstream workers.",
        ],
        risks: ["A technically complete feature may still fail if empty, error, or accessible states are omitted."],
        requirementIds: ["REQ-4"],
        milestoneIds: ["MS-1", "MS-2"],
        acceptanceCriterionIds: ["AC-3"],
        verificationGateIds: ["VG-3"],
        constraintIds: ["DC-1", "DC-2"],
      },
      {
        role: "qa_reviewer",
        title: "QA/Reviewer",
        objective: "Define acceptance evidence, verification gates, and review expectations before implementation.",
        findings: [
          "The goal loop needs a definition-of-done that reviewers can evaluate beyond the original vague goal.",
          "Blocked or skipped checks must be explicit so remaining work is actionable.",
        ],
        decisions: [
          "Use REQ-5 and AC-5 to require verification evidence.",
          "Reviewer evaluation should reference persisted requirement, acceptance, and gate IDs.",
        ],
        risks: ["Review may falsely pass if it only checks worker summaries rather than persisted criteria."],
        requirementIds: ["REQ-5"],
        milestoneIds: ["MS-3"],
        acceptanceCriterionIds: ["AC-2", "AC-5"],
        verificationGateIds: ["VG-1", "VG-2", "VG-3", "VG-4"],
        constraintIds: ["PC-2"],
      },
      {
        role: "marketing_growth",
        title: "Marketing/Growth",
        objective:
          "Capture optional launch, positioning, target segment, and success-metric context for product-facing work.",
        findings: [
          "Vague product goals often imply a target segment and success signal that implementation TODOs should preserve.",
          "Launch execution can remain out of scope while launch context informs product decisions.",
        ],
        decisions: [
          "Use REQ-6, AC-6, and optional VG-5 for lightweight growth/readiness context.",
          "Keep full campaign execution out of scope via OOS-2.",
        ],
        risks: ["A useful implementation may be hard to evaluate or announce if success metrics are never captured."],
        requirementIds: ["REQ-6"],
        milestoneIds: ["MS-3"],
        acceptanceCriterionIds: ["AC-6"],
        verificationGateIds: ["VG-5"],
        constraintIds: ["PC-1"],
      },
    ],
    consolidationNotes: [
      "Role outputs were normalized into scoped requirements, milestones, acceptance criteria, verification gates, design constraints, product constraints, and marketing/growth context.",
      "This discovery workflow is software-delivery oriented: it defines scope, build constraints, quality gates, and review criteria instead of open-ended ideation.",
      "Downstream implementation planning should treat the persisted specification as the product definition and definition-of-done.",
    ],
  };
}

function buildDefinitionOfDone(
  requirementIds: string[],
  acceptanceCriterionIds: string[],
  requiredGateIds: string[],
): GoalDefinitionOfDone {
  return {
    summary:
      "Done when all must/should scoped requirements are implemented, acceptance criteria are satisfied, required verification gates pass or record justified blockers, and review evaluates the result against this persisted product definition. Do not treat a partial MVP as complete when the original goal requests a broader product.",
    requirementIds,
    acceptanceCriterionIds,
    verificationGateIds: requiredGateIds,
    requiredArtifacts: [
      "Persisted GOAL_SPEC.json with discovery consolidation",
      "Implementation TODO results traceable to requirement and acceptance IDs",
      "Focused verification output or documented blockers",
      "Reviewer evaluation against the persisted definition-of-done",
    ],
    notes: [
      "REQ-6 and VG-5 are optional launch/growth context unless the implementation TODOs make them required.",
      "The original vague goal remains available through traceability, but completion is judged against this structured specification.",
    ],
  };
}

function concreteGoalSignals(goal: string, normalized: string): string[] {
  const signals: string[] = [];
  if (
    /(`[^`]+`|\b(?:src|test|tests|docs|scripts|tmp)\/|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml)\b)/i.test(
      goal,
    )
  ) {
    signals.push("file or path reference");
  }
  if (/\b(?:npm|pnpm|yarn|node|tsc|eslint|vitest|jest|pytest|cargo|go test)\b|\btest(?:s|ing)?\b/.test(normalized)) {
    signals.push("test or verification command");
  }
  if (/\b(?:acceptance criteria|definition of done|done when|verify|ensure that|must|should)\b/.test(normalized)) {
    signals.push("explicit acceptance or verification criteria");
  }
  if (/\b(?:fix|update|modify|rename|remove|refactor|migrate|implement|add|wire|export|handle)\b/.test(normalized)) {
    signals.push("implementation action verb");
  }
  if (
    /\b(?:function|class|component|endpoint|route|api|schema|parser|config|option|flag|error|bug)\b/.test(normalized)
  ) {
    signals.push("specific technical artifact");
  }
  if (/\b(?:from|to|in|inside|under|when|if|without)\b/.test(normalized) && normalized.length > 80) {
    signals.push("implementation constraints");
  }
  return unique(signals);
}

function vagueGoalSignals(normalized: string, wordCount: number): string[] {
  const signals: string[] = [];
  if (wordCount > 0 && wordCount <= 6) {
    signals.push("short goal with limited detail");
  }
  if (
    /\b(?:build|create|make|ship|improve|redesign|launch)\b.*\b(?:app|dashboard|platform|product|feature|website|tool|ui|experience|system)\b/.test(
      normalized,
    )
  ) {
    signals.push("broad product or feature request");
  }
  if (/\b(?:better|modern|simple|nice|polished|user-friendly|awesome|clean|robust|reliable)\b/.test(normalized)) {
    signals.push("qualitative outcome without measurable criteria");
  }
  if (/\b(?:something|stuff|etc|and so on|whatever)\b/.test(normalized)) {
    signals.push("placeholder wording");
  }
  return unique(signals);
}

function explicitDiscoveryRequested(normalized: string): boolean {
  return /\b(?:discover|discovery|scope|plan|product definition|requirements gathering)\b|\bdefine\s+(?:requirements|scope|product|project|acceptance|definition)\b/.test(
    normalized,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Goal discovery was aborted before producing a goal specification.");
  }
}
