export const GOAL_SPEC_SCHEMA_VERSION = 1;

export type GoalRequirementPriority = "must" | "should" | "could" | "wont";
export type GoalSpecTraceabilitySource = "user_goal" | "discovery_consolidation" | "manual";

export interface GoalSpecSourceArtifact {
  label: string;
  path?: string;
  description?: string;
}

export interface GoalSpecTraceability {
  originalUserGoal: string;
  goalRunId: string;
  source: GoalSpecTraceabilitySource;
  sourceArtifacts: GoalSpecSourceArtifact[];
}

export interface GoalRequirement {
  id: string;
  title: string;
  description: string;
  priority: GoalRequirementPriority;
  acceptanceCriterionIds: string[];
  milestoneIds: string[];
  source?: string;
}

export interface GoalScopedRequirements {
  inScope: GoalRequirement[];
  outOfScope: GoalRequirement[];
  assumptions: string[];
  openQuestions: string[];
}

export interface GoalMilestone {
  id: string;
  title: string;
  description: string;
  requirementIds: string[];
  acceptanceCriterionIds: string[];
  doneWhen: string[];
}

export interface GoalAcceptanceCriterion {
  id: string;
  description: string;
  requirementIds: string[];
  verificationGateIds: string[];
}

export interface GoalVerificationGate {
  id: string;
  title: string;
  description: string;
  required: boolean;
  command?: string;
  successCriteria: string[];
}

export interface GoalConstraint {
  id: string;
  title: string;
  description: string;
  rationale?: string;
}

export interface GoalDesignConstraints {
  uxPrinciples: string[];
  uiRequirements: string[];
  accessibility: string[];
  architecturalConstraints: string[];
  constraints: GoalConstraint[];
}

export interface GoalProductConstraints {
  targetUsers: string[];
  platforms: string[];
  businessRules: string[];
  compliance: string[];
  dependencies: string[];
  risks: string[];
  constraints: GoalConstraint[];
}

export interface GoalMarketingGrowthContext {
  targetSegments: string[];
  positioning: string[];
  acquisitionChannels: string[];
  growthMetrics: string[];
  launchConsiderations: string[];
}

export interface GoalDefinitionOfDone {
  summary: string;
  requirementIds: string[];
  acceptanceCriterionIds: string[];
  verificationGateIds: string[];
  requiredArtifacts: string[];
  notes: string[];
}

export type GoalDiscoveryPlanningRole =
  | "product_owner"
  | "project_manager"
  | "software_architect_tech_lead"
  | "ux_ui_designer"
  | "qa_reviewer"
  | "marketing_growth";

export interface GoalDiscoveryRoleOutput {
  role: GoalDiscoveryPlanningRole;
  title: string;
  objective: string;
  findings: string[];
  decisions: string[];
  risks: string[];
  requirementIds: string[];
  milestoneIds: string[];
  acceptanceCriterionIds: string[];
  verificationGateIds: string[];
  constraintIds: string[];
}

export interface GoalDiscoveryConsolidation {
  approach: string;
  roleOutputs: GoalDiscoveryRoleOutput[];
  consolidationNotes: string[];
}

export interface GoalSpecification {
  schemaVersion: typeof GOAL_SPEC_SCHEMA_VERSION;
  goalRunId: string;
  originalGoal: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  traceability: GoalSpecTraceability;
  discovery?: GoalDiscoveryConsolidation;
  scopedRequirements: GoalScopedRequirements;
  milestones: GoalMilestone[];
  acceptanceCriteria: GoalAcceptanceCriterion[];
  verificationGates: GoalVerificationGate[];
  designConstraints: GoalDesignConstraints;
  productConstraints: GoalProductConstraints;
  marketingGrowthContext?: GoalMarketingGrowthContext;
  definitionOfDone: GoalDefinitionOfDone;
}

export interface CreateGoalSpecificationOptions {
  goalRunId: string;
  originalGoal: string;
  summary?: string;
  now?: () => Date;
  traceability?: Partial<Omit<GoalSpecTraceability, "originalUserGoal" | "goalRunId">>;
  scopedRequirements?: GoalScopedRequirements;
  milestones?: GoalMilestone[];
  acceptanceCriteria?: GoalAcceptanceCriterion[];
  verificationGates?: GoalVerificationGate[];
  designConstraints?: GoalDesignConstraints;
  productConstraints?: GoalProductConstraints;
  discovery?: GoalDiscoveryConsolidation;
  marketingGrowthContext?: GoalMarketingGrowthContext;
  definitionOfDone?: GoalDefinitionOfDone;
}

export class GoalSpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalSpecificationError";
  }
}

export function createGoalSpecification(options: CreateGoalSpecificationOptions): GoalSpecification {
  const originalGoal = options.originalGoal.trim();
  if (!originalGoal) {
    throw new GoalSpecificationError("Goal specification requires a non-empty originalGoal.");
  }
  if (!options.goalRunId.trim()) {
    throw new GoalSpecificationError("Goal specification requires a non-empty goalRunId.");
  }

  const timestamp = (options.now?.() ?? new Date()).toISOString();
  return validateGoalSpecification({
    schemaVersion: GOAL_SPEC_SCHEMA_VERSION,
    goalRunId: options.goalRunId,
    originalGoal,
    summary: options.summary?.trim() || originalGoal,
    createdAt: timestamp,
    updatedAt: timestamp,
    traceability: {
      originalUserGoal: originalGoal,
      goalRunId: options.goalRunId,
      source: options.traceability?.source ?? "user_goal",
      sourceArtifacts: options.traceability?.sourceArtifacts ?? [],
    },
    ...(options.discovery ? { discovery: options.discovery } : {}),
    scopedRequirements: options.scopedRequirements ?? emptyScopedRequirements(),
    milestones: options.milestones ?? [],
    acceptanceCriteria: options.acceptanceCriteria ?? [],
    verificationGates: options.verificationGates ?? [],
    designConstraints: options.designConstraints ?? emptyDesignConstraints(),
    productConstraints: options.productConstraints ?? emptyProductConstraints(),
    ...(options.marketingGrowthContext ? { marketingGrowthContext: options.marketingGrowthContext } : {}),
    definitionOfDone:
      options.definitionOfDone ??
      emptyDefinitionOfDone(
        "The goal is complete when all scoped requirements, acceptance criteria, and required verification gates are satisfied.",
      ),
  });
}

export function validateGoalSpecification(value: unknown): GoalSpecification {
  const spec = requireObject(value, "goal specification");
  if (spec.schemaVersion !== GOAL_SPEC_SCHEMA_VERSION) {
    throw new GoalSpecificationError(`Unsupported goal specification schemaVersion: ${String(spec.schemaVersion)}.`);
  }

  const goalRunId = requireString(spec, "goalRunId", "goal specification");
  const originalGoal = requireString(spec, "originalGoal", "goal specification");
  requireString(spec, "summary", "goal specification");
  requireString(spec, "createdAt", "goal specification");
  requireString(spec, "updatedAt", "goal specification");

  validateTraceability(requireObjectField(spec, "traceability", "goal specification"), goalRunId, originalGoal);
  if (spec.discovery !== undefined) {
    validateDiscoveryConsolidation(requireObject(spec.discovery, "goal specification.discovery"));
  }
  validateScopedRequirements(requireObjectField(spec, "scopedRequirements", "goal specification"));
  validateArrayField(spec, "milestones", "goal specification", validateMilestone);
  validateArrayField(spec, "acceptanceCriteria", "goal specification", validateAcceptanceCriterion);
  validateArrayField(spec, "verificationGates", "goal specification", validateVerificationGate);
  validateDesignConstraints(requireObjectField(spec, "designConstraints", "goal specification"));
  validateProductConstraints(requireObjectField(spec, "productConstraints", "goal specification"));
  if (spec.marketingGrowthContext !== undefined) {
    validateMarketingGrowthContext(
      requireObject(spec.marketingGrowthContext, "goal specification.marketingGrowthContext"),
    );
  }
  validateDefinitionOfDone(requireObjectField(spec, "definitionOfDone", "goal specification"));

  return spec as unknown as GoalSpecification;
}

export function goalSpecificationToMarkdown(specInput: GoalSpecification): string {
  const spec = validateGoalSpecification(specInput);
  const lines = [
    "## Persisted goal specification",
    "",
    `Schema version: ${spec.schemaVersion}`,
    `Goal run: ${spec.goalRunId}`,
    `Original user goal: ${spec.originalGoal}`,
    `Summary: ${spec.summary}`,
  ];

  if (spec.discovery) {
    lines.push("", "### Discovery planning", "", ...formatDiscoveryConsolidation(spec.discovery));
  }

  lines.push(
    "",
    "### Scoped requirements",
    "",
    "In scope:",
    ...formatRequirements(spec.scopedRequirements.inScope),
    "",
    "Out of scope:",
    ...formatRequirements(spec.scopedRequirements.outOfScope),
    "",
    "Assumptions:",
    ...formatStringList(spec.scopedRequirements.assumptions),
    "",
    "Open questions:",
    ...formatStringList(spec.scopedRequirements.openQuestions),
    "",
    "### Milestones",
    "",
    ...formatMilestones(spec.milestones),
    "",
    "### Acceptance criteria",
    "",
    ...formatAcceptanceCriteria(spec.acceptanceCriteria),
    "",
    "### Verification gates",
    "",
    ...formatVerificationGates(spec.verificationGates),
    "",
    "### Design constraints",
    "",
    ...formatConstraintSection(spec.designConstraints),
    "",
    "### Product constraints",
    "",
    ...formatProductConstraintSection(spec.productConstraints),
  );

  if (spec.marketingGrowthContext) {
    lines.push("", "### Marketing/growth context", "", ...formatMarketingGrowthContext(spec.marketingGrowthContext));
  }

  lines.push(
    "",
    "### Definition of done",
    "",
    spec.definitionOfDone.summary,
    "",
    `Requirement IDs: ${formatInlineIds(spec.definitionOfDone.requirementIds)}`,
    `Acceptance criterion IDs: ${formatInlineIds(spec.definitionOfDone.acceptanceCriterionIds)}`,
    `Verification gate IDs: ${formatInlineIds(spec.definitionOfDone.verificationGateIds)}`,
    "",
    "Required artifacts:",
    ...formatStringList(spec.definitionOfDone.requiredArtifacts),
    "",
    "Notes:",
    ...formatStringList(spec.definitionOfDone.notes),
  );

  return `${lines.join("\n")}\n`;
}

function emptyScopedRequirements(): GoalScopedRequirements {
  return { inScope: [], outOfScope: [], assumptions: [], openQuestions: [] };
}

function emptyDesignConstraints(): GoalDesignConstraints {
  return { uxPrinciples: [], uiRequirements: [], accessibility: [], architecturalConstraints: [], constraints: [] };
}

function emptyProductConstraints(): GoalProductConstraints {
  return {
    targetUsers: [],
    platforms: [],
    businessRules: [],
    compliance: [],
    dependencies: [],
    risks: [],
    constraints: [],
  };
}

function emptyDefinitionOfDone(summary: string): GoalDefinitionOfDone {
  return {
    summary,
    requirementIds: [],
    acceptanceCriterionIds: [],
    verificationGateIds: [],
    requiredArtifacts: [],
    notes: [],
  };
}

function validateTraceability(traceability: JsonObject, goalRunId: string, originalGoal: string): void {
  const traceGoal = requireString(traceability, "originalUserGoal", "goal specification.traceability");
  const traceRunId = requireString(traceability, "goalRunId", "goal specification.traceability");
  if (traceGoal !== originalGoal) {
    throw new GoalSpecificationError("Goal specification traceability.originalUserGoal must match originalGoal.");
  }
  if (traceRunId !== goalRunId) {
    throw new GoalSpecificationError("Goal specification traceability.goalRunId must match goalRunId.");
  }
  const source = requireString(traceability, "source", "goal specification.traceability");
  if (!isTraceabilitySource(source)) {
    throw new GoalSpecificationError(`Invalid goal specification traceability source: ${source}.`);
  }
  validateArrayField(traceability, "sourceArtifacts", "goal specification.traceability", validateSourceArtifact);
}

function validateSourceArtifact(value: unknown, path: string): void {
  const artifact = requireObject(value, path);
  requireString(artifact, "label", path);
  optionalString(artifact, "path", path);
  optionalString(artifact, "description", path);
}

function validateDiscoveryConsolidation(value: JsonObject): void {
  requireString(value, "approach", "goal specification.discovery");
  validateArrayField(value, "roleOutputs", "goal specification.discovery", validateDiscoveryRoleOutput);
  requireStringArray(value, "consolidationNotes", "goal specification.discovery");
}

function validateDiscoveryRoleOutput(value: unknown, path: string): void {
  const output = requireObject(value, path);
  const role = requireString(output, "role", path);
  if (!isDiscoveryPlanningRole(role)) {
    throw new GoalSpecificationError(`${path}.role is not a supported discovery planning role.`);
  }
  requireString(output, "title", path);
  requireString(output, "objective", path);
  requireStringArray(output, "findings", path);
  requireStringArray(output, "decisions", path);
  requireStringArray(output, "risks", path);
  requireStringArray(output, "requirementIds", path);
  requireStringArray(output, "milestoneIds", path);
  requireStringArray(output, "acceptanceCriterionIds", path);
  requireStringArray(output, "verificationGateIds", path);
  requireStringArray(output, "constraintIds", path);
}

function validateScopedRequirements(value: JsonObject): void {
  validateArrayField(value, "inScope", "goal specification.scopedRequirements", validateRequirement);
  validateArrayField(value, "outOfScope", "goal specification.scopedRequirements", validateRequirement);
  requireStringArray(value, "assumptions", "goal specification.scopedRequirements");
  requireStringArray(value, "openQuestions", "goal specification.scopedRequirements");
}

function validateRequirement(value: unknown, path: string): void {
  const requirement = requireObject(value, path);
  requireString(requirement, "id", path);
  requireString(requirement, "title", path);
  requireString(requirement, "description", path);
  const priority = requireString(requirement, "priority", path);
  if (!isRequirementPriority(priority)) {
    throw new GoalSpecificationError(`${path}.priority must be one of must, should, could, or wont.`);
  }
  requireStringArray(requirement, "acceptanceCriterionIds", path);
  requireStringArray(requirement, "milestoneIds", path);
  optionalString(requirement, "source", path);
}

function validateMilestone(value: unknown, path: string): void {
  const milestone = requireObject(value, path);
  requireString(milestone, "id", path);
  requireString(milestone, "title", path);
  requireString(milestone, "description", path);
  requireStringArray(milestone, "requirementIds", path);
  requireStringArray(milestone, "acceptanceCriterionIds", path);
  requireStringArray(milestone, "doneWhen", path);
}

function validateAcceptanceCriterion(value: unknown, path: string): void {
  const criterion = requireObject(value, path);
  requireString(criterion, "id", path);
  requireString(criterion, "description", path);
  requireStringArray(criterion, "requirementIds", path);
  requireStringArray(criterion, "verificationGateIds", path);
}

function validateVerificationGate(value: unknown, path: string): void {
  const gate = requireObject(value, path);
  requireString(gate, "id", path);
  requireString(gate, "title", path);
  requireString(gate, "description", path);
  if (typeof gate.required !== "boolean") {
    throw new GoalSpecificationError(`${path}.required must be a boolean.`);
  }
  optionalString(gate, "command", path);
  requireStringArray(gate, "successCriteria", path);
}

function validateDesignConstraints(value: JsonObject): void {
  requireStringArray(value, "uxPrinciples", "goal specification.designConstraints");
  requireStringArray(value, "uiRequirements", "goal specification.designConstraints");
  requireStringArray(value, "accessibility", "goal specification.designConstraints");
  requireStringArray(value, "architecturalConstraints", "goal specification.designConstraints");
  validateArrayField(value, "constraints", "goal specification.designConstraints", validateConstraint);
}

function validateProductConstraints(value: JsonObject): void {
  requireStringArray(value, "targetUsers", "goal specification.productConstraints");
  requireStringArray(value, "platforms", "goal specification.productConstraints");
  requireStringArray(value, "businessRules", "goal specification.productConstraints");
  requireStringArray(value, "compliance", "goal specification.productConstraints");
  requireStringArray(value, "dependencies", "goal specification.productConstraints");
  requireStringArray(value, "risks", "goal specification.productConstraints");
  validateArrayField(value, "constraints", "goal specification.productConstraints", validateConstraint);
}

function validateConstraint(value: unknown, path: string): void {
  const constraint = requireObject(value, path);
  requireString(constraint, "id", path);
  requireString(constraint, "title", path);
  requireString(constraint, "description", path);
  optionalString(constraint, "rationale", path);
}

function validateMarketingGrowthContext(value: JsonObject): void {
  requireStringArray(value, "targetSegments", "goal specification.marketingGrowthContext");
  requireStringArray(value, "positioning", "goal specification.marketingGrowthContext");
  requireStringArray(value, "acquisitionChannels", "goal specification.marketingGrowthContext");
  requireStringArray(value, "growthMetrics", "goal specification.marketingGrowthContext");
  requireStringArray(value, "launchConsiderations", "goal specification.marketingGrowthContext");
}

function validateDefinitionOfDone(value: JsonObject): void {
  requireString(value, "summary", "goal specification.definitionOfDone");
  requireStringArray(value, "requirementIds", "goal specification.definitionOfDone");
  requireStringArray(value, "acceptanceCriterionIds", "goal specification.definitionOfDone");
  requireStringArray(value, "verificationGateIds", "goal specification.definitionOfDone");
  requireStringArray(value, "requiredArtifacts", "goal specification.definitionOfDone");
  requireStringArray(value, "notes", "goal specification.definitionOfDone");
}

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoalSpecificationError(`${path} must be an object.`);
  }
  return value as JsonObject;
}

function requireObjectField(value: JsonObject, key: string, path: string): JsonObject {
  return requireObject(value[key], `${path}.${key}`);
}

function requireString(value: JsonObject, key: string, path: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new GoalSpecificationError(`${path}.${key} must be a non-empty string.`);
  }
  return candidate;
}

function optionalString(value: JsonObject, key: string, path: string): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new GoalSpecificationError(`${path}.${key} must be a string when present.`);
  }
}

function requireStringArray(value: JsonObject, key: string, path: string): void {
  const candidate = value[key];
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string")) {
    throw new GoalSpecificationError(`${path}.${key} must be an array of strings.`);
  }
}

function validateArrayField(
  value: JsonObject,
  key: string,
  path: string,
  validateItem: (item: unknown, path: string) => void,
): void {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    throw new GoalSpecificationError(`${path}.${key} must be an array.`);
  }
  candidate.forEach((item, index) => validateItem(item, `${path}.${key}[${index}]`));
}

function isRequirementPriority(value: string): value is GoalRequirementPriority {
  return value === "must" || value === "should" || value === "could" || value === "wont";
}

function isTraceabilitySource(value: string): value is GoalSpecTraceabilitySource {
  return value === "user_goal" || value === "discovery_consolidation" || value === "manual";
}

function isDiscoveryPlanningRole(value: string): value is GoalDiscoveryPlanningRole {
  return (
    value === "product_owner" ||
    value === "project_manager" ||
    value === "software_architect_tech_lead" ||
    value === "ux_ui_designer" ||
    value === "qa_reviewer" ||
    value === "marketing_growth"
  );
}

function formatRequirements(requirements: GoalRequirement[]): string[] {
  if (requirements.length === 0) {
    return ["- none"];
  }
  return requirements.map((item) => `- ${item.id} (${item.priority}): ${item.title} — ${item.description}`);
}

function formatMilestones(milestones: GoalMilestone[]): string[] {
  if (milestones.length === 0) {
    return ["- none"];
  }
  return milestones.map((item) => `- ${item.id}: ${item.title} — ${item.description}`);
}

function formatAcceptanceCriteria(criteria: GoalAcceptanceCriterion[]): string[] {
  if (criteria.length === 0) {
    return ["- none"];
  }
  return criteria.map((item) => `- ${item.id}: ${item.description}`);
}

function formatVerificationGates(gates: GoalVerificationGate[]): string[] {
  if (gates.length === 0) {
    return ["- none"];
  }
  return gates.map((item) => {
    const command = item.command ? ` Command: ${item.command}.` : "";
    return `- ${item.id}${item.required ? " (required)" : " (optional)"}: ${item.title} — ${item.description}.${command}`;
  });
}

function formatConstraintSection(constraints: GoalDesignConstraints): string[] {
  return [
    "UX principles:",
    ...formatStringList(constraints.uxPrinciples),
    "UI requirements:",
    ...formatStringList(constraints.uiRequirements),
    "Accessibility:",
    ...formatStringList(constraints.accessibility),
    "Architectural constraints:",
    ...formatStringList(constraints.architecturalConstraints),
    "Other constraints:",
    ...formatConstraints(constraints.constraints),
  ];
}

function formatProductConstraintSection(constraints: GoalProductConstraints): string[] {
  return [
    "Target users:",
    ...formatStringList(constraints.targetUsers),
    "Platforms:",
    ...formatStringList(constraints.platforms),
    "Business rules:",
    ...formatStringList(constraints.businessRules),
    "Compliance:",
    ...formatStringList(constraints.compliance),
    "Dependencies:",
    ...formatStringList(constraints.dependencies),
    "Risks:",
    ...formatStringList(constraints.risks),
    "Other constraints:",
    ...formatConstraints(constraints.constraints),
  ];
}

function formatMarketingGrowthContext(context: GoalMarketingGrowthContext): string[] {
  return [
    "Target segments:",
    ...formatStringList(context.targetSegments),
    "Positioning:",
    ...formatStringList(context.positioning),
    "Acquisition channels:",
    ...formatStringList(context.acquisitionChannels),
    "Growth metrics:",
    ...formatStringList(context.growthMetrics),
    "Launch considerations:",
    ...formatStringList(context.launchConsiderations),
  ];
}

function formatDiscoveryConsolidation(discovery: GoalDiscoveryConsolidation): string[] {
  return [
    `Approach: ${discovery.approach}`,
    "",
    "Role outputs:",
    ...discovery.roleOutputs.map(
      (output) =>
        `- ${output.title}: ${output.objective} Requirements: ${formatInlineIds(output.requirementIds)}. Acceptance: ${formatInlineIds(output.acceptanceCriterionIds)}. Gates: ${formatInlineIds(output.verificationGateIds)}.`,
    ),
    "",
    "Consolidation notes:",
    ...formatStringList(discovery.consolidationNotes),
  ];
}

function formatConstraints(constraints: GoalConstraint[]): string[] {
  if (constraints.length === 0) {
    return ["- none"];
  }
  return constraints.map((item) => `- ${item.id}: ${item.title} — ${item.description}`);
}

function formatStringList(items: string[]): string[] {
  if (items.length === 0) {
    return ["- none"];
  }
  return items.map((item) => `- ${item}`);
}

function formatInlineIds(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}
