import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCoordinator, type CoordinatorResult, type RunCoordinatorOptions } from "./coordinator.ts";
import { type GoalIterationState, type GoalLoopState, recordGeneratedTodo, startGoalIteration } from "./goal_loop.ts";
import { GoalStateStore } from "./goal_state.ts";
import type { GoalSpecification } from "./goal_spec.ts";
import { parseTasks } from "./todo_parser.ts";
import {
  applyGoalInstructionsToTodoMarkdown,
  extractAndValidateTodoMarkdown,
  validateTodoMarkdown,
} from "./todo_generator.ts";

export const GOAL_TODO_GENERATION_PAYLOAD_FILE = "TODO_GENERATION_TASK.md";
export const GOAL_TODO_GENERATION_RAW_FILE = "GENERATED_TODO_RAW.md";
export const GOAL_TODO_GENERATION_TODO_FILE = "TODO.md";

export type GoalTodoGenerationLongTaskRunner = (options: RunCoordinatorOptions) => Promise<CoordinatorResult>;

export interface GoalTodoGenerationOptions {
  state: GoalLoopState;
  cwd?: string;
  store?: GoalStateStore;
  longTaskRunner?: GoalTodoGenerationLongTaskRunner;
  abortSignal?: AbortSignal;
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  maxBashTimeoutMs?: number;
  now?: () => Date;
  additionalContext?: string;
  outputPath?: string;
  goalSpecification?: GoalSpecification;
}

export interface GoalTodoGenerationResult {
  state: GoalLoopState;
  iteration: GoalIterationState;
  todoMarkdown: string;
  todoPath: string;
  rawTodoPath: string;
  payloadPath: string;
  contentHash: string;
  taskCount: number;
  childResult: CoordinatorResult;
}

export class GoalTodoGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalTodoGenerationError";
  }
}

export async function runGoalTodoGenerationLongTask(
  options: GoalTodoGenerationOptions,
): Promise<GoalTodoGenerationResult> {
  const now = options.now ?? (() => new Date());
  let state = options.state;
  let previousTraceLength = state.trace.length;
  const store =
    options.store ?? new GoalStateStore({ cwd: options.cwd, goalRunId: state.goalRunId, goalRunDir: state.goalRunDir });

  throwIfAborted(options.abortSignal);
  state = ensurePendingGenerationIteration(state, { now, abortSignal: options.abortSignal });
  await persistStateChange(store, previousTraceLength, state);
  previousTraceLength = state.trace.length;

  const iteration = currentPendingIteration(state);
  const iterationDir = store.iterationDir(iteration.iteration);
  await mkdir(iterationDir, { recursive: true });

  const rawTodoPath = options.outputPath ?? path.join(iterationDir, GOAL_TODO_GENERATION_RAW_FILE);
  const todoPath = path.join(iterationDir, GOAL_TODO_GENERATION_TODO_FILE);
  const goalSpecification = options.goalSpecification ?? (await store.tryLoadGoalSpecification());
  const payload = buildGoalTodoGenerationTaskPayload({
    state,
    iteration: iteration.iteration,
    outputPath: rawTodoPath,
    additionalContext: options.additionalContext ?? buildPreviousIterationContext(state),
    goalSpecification,
    goalSpecificationPath: goalSpecification ? store.paths.goalSpecPath : undefined,
  });
  const payloadPath = path.join(iterationDir, GOAL_TODO_GENERATION_PAYLOAD_FILE);
  await writeFile(payloadPath, payload, "utf8");

  const childResult = await (options.longTaskRunner ?? runCoordinator)({
    inputText: payload,
    commit: false,
    goal: state.goal,
    cwd: options.cwd,
    runId: `${state.goalRunId}-todo-generation-${String(iteration.iteration).padStart(2, "0")}`,
    abortSignal: options.abortSignal,
    workerModel: options.model,
    workerModelName: options.modelName,
    taskThinking: options.thinkingLevel,
    taskTimeoutMs: timeoutForIteration(iteration, state, now()),
    maxBashTimeoutMs: options.maxBashTimeoutMs,
  });

  throwIfAborted(options.abortSignal);
  const rawOutput = await readGeneratedTodo(rawTodoPath, childResult);
  const todoMarkdown = normalizeGeneratedTodoMarkdown(
    rawOutput,
    state.goal,
    goalSpecification,
    store.paths.goalSpecPath,
  );
  const taskCount = parseTasks(todoMarkdown).length;
  const contentHash = sha256(todoMarkdown);
  await writeFile(todoPath, todoMarkdown, "utf8");

  state = recordGeneratedTodo(
    state,
    iteration.iteration,
    {
      todoPath,
      summary: `Generated TODO with ${taskCount} task(s).`,
      contentHash,
      payloadPath,
      rawTodoPath,
      generatorRunId: childResult.runId,
      generatorRunDir: childResult.runDir,
      generatorResultPath: childResult.resultPath,
      generatorTaskResultPath: childResult.taskResultPath,
    },
    { now: now() },
  );
  await persistStateChange(store, previousTraceLength, state);
  const updatedIteration = currentIteration(state, iteration.iteration);
  await store.writeIterationSnapshot(updatedIteration);
  await store.appendIterationResult(updatedIteration);

  return {
    state,
    iteration: updatedIteration,
    todoMarkdown,
    todoPath,
    rawTodoPath,
    payloadPath,
    contentHash,
    taskCount,
    childResult,
  };
}

export function buildGoalTodoGenerationTaskPayload(options: {
  state: Pick<GoalLoopState, "goal" | "goalRunId" | "limits">;
  iteration: number;
  outputPath: string;
  additionalContext?: string;
  goalSpecification?: GoalSpecification;
  goalSpecificationPath?: string;
}): string {
  const context = options.additionalContext?.trim();
  const contextBlock = context ? `\nAdditional iteration context:\n\n${markdownFence(context, "text")}\n` : "";
  const specificationBlock = options.goalSpecification
    ? `\nPersisted goal specification (source of truth for implementation TODOs):\n\n${markdownFence(
        buildGoalSpecificationGenerationContext(options.goalSpecification, options.goalSpecificationPath),
        "markdown",
      )}\n`
    : "";
  const iterationPolicy = `- Goal-loop iteration target: generate implementation work for iteration ${options.iteration} of at least ${options.state.limits.minIterations} required iteration(s), with a hard maximum of ${options.state.limits.maxIterations}.
- Do not generate a no-op TODO merely because a previous reviewer believed the goal was complete before the minimum iteration target. Always look for the next concrete improvement, hardening, verification, UX, security, performance, docs, maintainability, or product-completeness pass until the minimum is reached.`;

  return `# Pi Long Task TODO

## Global instructions and constraints

- Long task goal: ${oneLine(options.state.goal)}
- This is goal-loop TODO generation iteration ${options.iteration} for goal run ${options.state.goalRunId}.
- Only generate TODO markdown for future workers; do not implement, edit, test, refactor, or otherwise perform the goal work in this generation run.
- Write the generated Pi Long Task-compatible TODO markdown to \`${options.outputPath}\`.
- Do not wrap the generated file in a code fence and do not include commentary outside the TODO markdown in that file.
- Keep generated tasks focused, independently assignable, and safe for separate worker sessions.
${iterationPolicy}
${
  options.goalSpecification
    ? "- A persisted goal specification is available; derive implementation TODOs from that specification rather than only the original vague goal.\n- Ensure generated tasks explicitly cover relevant requirement IDs, milestones, acceptance criteria, verification gates, constraints, and definition-of-done items from the specification.\n- Include spec IDs (for example REQ-*, MS-*, AC-*, VG-*) in generated task goals/status/verification/done-when guidance wherever applicable.\n"
    : ""
}
## Progress

- [ ] TODO 1 — Generate Pi Long Task TODO markdown

---

## TODO 1 — Generate Pi Long Task TODO markdown

**Goal:** Convert the high-level goal into a valid Pi Long Task TODO plan for the next implementation long task.

**Status:**
- [ ] Analyze the high-level goal and any iteration context.
- [ ] Create TODO markdown that starts with \`# Pi Long Task TODO\`.
- [ ] Include a \`## Progress\` section with one unchecked \`- [ ] TODO N — Title\` line per generated task.
- [ ] Include a \`---\` separator before generated task sections.
- [ ] Include sequential \`## TODO N — Title\` sections with \`**Goal:**\`, \`**Status:**\`, \`**Verify:**\`, and \`**Done when:**\` guidance.
- [ ] Write only the generated TODO markdown to \`${options.outputPath}\`.

**Verify:**
- Confirm the file at \`${options.outputPath}\` exists.
- Confirm it starts with \`# Pi Long Task TODO\`, has a \`## Progress\` section, a \`---\` separator, sequential TODO sections, unchecked status checkboxes, and concrete verification instructions.

**Done when:**
- \`${options.outputPath}\` contains valid Pi Long Task-compatible TODO markdown for achieving the high-level goal.

High-level goal:

${markdownFence(options.state.goal, "text")}
${specificationBlock}${contextBlock}`;
}

function ensurePendingGenerationIteration(
  state: GoalLoopState,
  options: { now: () => Date; abortSignal?: AbortSignal },
): GoalLoopState {
  if (state.currentIteration > 0) {
    const current = currentIteration(state, state.currentIteration);
    if (current.status === "pending") {
      return state;
    }
  }
  return startGoalIteration(state, { now: options.now(), abortSignal: options.abortSignal });
}

function currentPendingIteration(state: GoalLoopState): GoalIterationState {
  const iteration = currentIteration(state, state.currentIteration);
  if (iteration.status !== "pending") {
    throw new GoalTodoGenerationError(
      `Goal iteration ${iteration.iteration} is ${iteration.status}; expected pending TODO generation.`,
    );
  }
  return iteration;
}

function currentIteration(state: GoalLoopState, iterationNumber: number): GoalIterationState {
  const iteration = state.iterations.find((item) => item.iteration === iterationNumber);
  if (!iteration) {
    throw new GoalTodoGenerationError(`Goal iteration ${iterationNumber || "<none>"} does not exist.`);
  }
  return iteration;
}

async function persistStateChange(
  store: GoalStateStore,
  previousTraceLength: number,
  state: GoalLoopState,
): Promise<void> {
  await store.saveState(state);
  await store.appendNewTraceEvents(previousTraceLength, state);
}

async function readGeneratedTodo(rawTodoPath: string, childResult: CoordinatorResult): Promise<string> {
  try {
    return await readFile(rawTodoPath, "utf8");
  } catch (error) {
    throw new GoalTodoGenerationError(
      `TODO-generation long task did not write ${rawTodoPath} (child status: ${childResult.status}): ${errorMessage(error)}`,
    );
  }
}

function normalizeGeneratedTodoMarkdown(
  rawOutput: string,
  goal: string,
  goalSpecification: GoalSpecification | undefined,
  goalSpecificationPath: string,
): string {
  const extracted = extractAndValidateTodoMarkdown(rawOutput);
  const withGoalInstructions = applyGoalInstructionsToTodoMarkdown(extracted, goal);
  if (!goalSpecification) {
    return withGoalInstructions;
  }
  return applyGoalSpecificationInstructionsToTodoMarkdown(
    withGoalInstructions,
    goalSpecification,
    goalSpecificationPath,
  );
}

function buildGoalSpecificationGenerationContext(spec: GoalSpecification, goalSpecificationPath?: string): string {
  const lines = [
    `Goal spec path: ${goalSpecificationPath ?? "<not provided>"}`,
    `Goal run: ${spec.goalRunId}`,
    `Original user goal: ${oneLine(spec.originalGoal)}`,
    `Specification summary: ${oneLine(spec.summary)}`,
    "",
    "Implementation planning instructions:",
    "- Treat this persisted specification as the implementation source of truth; use the original vague goal only for traceability.",
    "- Generate tasks that map to milestones, in-scope requirements, acceptance criteria, verification gates, and definition-of-done items.",
    "- Cite relevant IDs (REQ-*, MS-*, AC-*, VG-*) in task goals, status checklist items, verification, and done-when guidance.",
    "- Do not create tasks for out-of-scope requirements unless needed to preserve or document non-goals.",
    "",
    "In-scope requirements:",
    ...formatRequirementLines(spec.scopedRequirements.inScope),
    "",
    "Out-of-scope requirements / non-goals:",
    ...formatRequirementLines(spec.scopedRequirements.outOfScope),
    "",
    "Milestones:",
    ...formatMilestoneLines(spec.milestones),
    "",
    "Acceptance criteria:",
    ...formatAcceptanceCriterionLines(spec.acceptanceCriteria),
    "",
    "Verification gates:",
    ...formatVerificationGateLines(spec.verificationGates),
    "",
    "Definition of done:",
    `- Summary: ${oneLine(spec.definitionOfDone.summary)}`,
    `- Requirement IDs: ${formatIdList(spec.definitionOfDone.requirementIds)}`,
    `- Acceptance criterion IDs: ${formatIdList(spec.definitionOfDone.acceptanceCriterionIds)}`,
    `- Verification gate IDs: ${formatIdList(spec.definitionOfDone.verificationGateIds)}`,
    ...spec.definitionOfDone.requiredArtifacts.map((artifact) => `- Required artifact: ${oneLine(artifact)}`),
    ...spec.definitionOfDone.notes.map((note) => `- Note: ${oneLine(note)}`),
    "",
    "Design and product constraints:",
    ...formatConstraintContext(spec),
  ];
  return lines.join("\n");
}

function applyGoalSpecificationInstructionsToTodoMarkdown(
  markdown: string,
  spec: GoalSpecification,
  goalSpecificationPath: string,
): string {
  const additions = buildGoalSpecificationTodoInstructions(spec, goalSpecificationPath);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const progressIndex = lines.findIndex((line) => /^##\s+Progress\s*$/i.test(line.trim()));
  if (progressIndex < 0) {
    return markdown;
  }

  const existingGlobalText = lines.slice(0, progressIndex).join("\n");
  const missing = additions.filter((line) => !existingGlobalText.includes(line));
  if (missing.length === 0) {
    return markdown;
  }

  const before = trimTrailingBlankLines(lines.slice(0, progressIndex));
  const after = trimLeadingBlankLines(lines.slice(progressIndex));
  const hasGlobalHeading = /^Global instructions:\s*$/im.test(existingGlobalText);
  const block = hasGlobalHeading ? missing : ["Global instructions:", ...missing];
  const next = ensureTrailingNewline([...before, "", ...block, "", ...after].join("\n"));
  validateTodoMarkdown(next);
  return next;
}

function buildGoalSpecificationTodoInstructions(spec: GoalSpecification, goalSpecificationPath: string): string[] {
  const lines = [
    `- Persisted goal specification: ${goalSpecificationPath}`,
    `- Goal specification summary: ${oneLine(spec.summary)}`,
    `- Definition of done: ${oneLine(spec.definitionOfDone.summary)}`,
    `- Implementation TODOs must trace to requirements: ${formatIdList(spec.definitionOfDone.requirementIds)}`,
    `- Implementation TODOs must satisfy acceptance criteria: ${formatIdList(
      spec.definitionOfDone.acceptanceCriterionIds,
    )}`,
    `- Required verification gates: ${formatIdList(requiredVerificationGateIds(spec))}`,
  ];
  const milestoneIds = spec.milestones.map((milestone) => milestone.id);
  if (milestoneIds.length > 0) {
    lines.push(`- Implementation TODOs should be sequenced by milestones: ${formatIdList(milestoneIds)}`);
  }
  return lines;
}

function formatRequirementLines(requirements: GoalSpecification["scopedRequirements"]["inScope"]): string[] {
  if (requirements.length === 0) {
    return ["- None specified."];
  }
  return requirements.map(
    (requirement) =>
      `- ${requirement.id} (${requirement.priority}) ${oneLine(requirement.title)} — ${oneLine(
        requirement.description,
      )}; milestones: ${formatIdList(requirement.milestoneIds)}; acceptance: ${formatIdList(
        requirement.acceptanceCriterionIds,
      )}`,
  );
}

function formatMilestoneLines(milestones: GoalSpecification["milestones"]): string[] {
  if (milestones.length === 0) {
    return ["- None specified."];
  }
  return milestones.map(
    (milestone) =>
      `- ${milestone.id} ${oneLine(milestone.title)} — ${oneLine(milestone.description)}; requirements: ${formatIdList(
        milestone.requirementIds,
      )}; acceptance: ${formatIdList(milestone.acceptanceCriterionIds)}; done when: ${formatIdList(
        milestone.doneWhen.map(oneLine),
      )}`,
  );
}

function formatAcceptanceCriterionLines(criteria: GoalSpecification["acceptanceCriteria"]): string[] {
  if (criteria.length === 0) {
    return ["- None specified."];
  }
  return criteria.map(
    (criterion) =>
      `- ${criterion.id} ${oneLine(criterion.description)}; requirements: ${formatIdList(
        criterion.requirementIds,
      )}; verification gates: ${formatIdList(criterion.verificationGateIds)}`,
  );
}

function formatVerificationGateLines(gates: GoalSpecification["verificationGates"]): string[] {
  if (gates.length === 0) {
    return ["- None specified."];
  }
  return gates.map((gate) => {
    const command = gate.command ? `; command: ${oneLine(gate.command)}` : "";
    return `- ${gate.id} ${gate.required ? "required" : "optional"} ${oneLine(gate.title)} — ${oneLine(
      gate.description,
    )}${command}; success: ${formatIdList(gate.successCriteria.map(oneLine))}`;
  });
}

function formatConstraintContext(spec: GoalSpecification): string[] {
  const lines = [
    ...spec.designConstraints.uxPrinciples.map((item) => `- UX principle: ${oneLine(item)}`),
    ...spec.designConstraints.uiRequirements.map((item) => `- UI requirement: ${oneLine(item)}`),
    ...spec.designConstraints.accessibility.map((item) => `- Accessibility: ${oneLine(item)}`),
    ...spec.designConstraints.architecturalConstraints.map((item) => `- Architecture: ${oneLine(item)}`),
    ...spec.designConstraints.constraints.map(
      (constraint) => `- ${constraint.id} ${oneLine(constraint.title)} — ${oneLine(constraint.description)}`,
    ),
    ...spec.productConstraints.businessRules.map((item) => `- Business rule: ${oneLine(item)}`),
    ...spec.productConstraints.compliance.map((item) => `- Compliance: ${oneLine(item)}`),
    ...spec.productConstraints.dependencies.map((item) => `- Dependency: ${oneLine(item)}`),
    ...spec.productConstraints.risks.map((item) => `- Risk: ${oneLine(item)}`),
    ...spec.productConstraints.constraints.map(
      (constraint) => `- ${constraint.id} ${oneLine(constraint.title)} — ${oneLine(constraint.description)}`,
    ),
  ];
  return lines.length > 0 ? lines : ["- None specified."];
}

function requiredVerificationGateIds(spec: GoalSpecification): string[] {
  const required = spec.verificationGates.filter((gate) => gate.required).map((gate) => gate.id);
  return required.length > 0 ? required : spec.definitionOfDone.verificationGateIds;
}

function formatIdList(values: readonly string[]): string {
  return values.length > 0 ? values.map(oneLine).join(", ") : "none";
}

function trimTrailingBlankLines(lines: string[]): string[] {
  while (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  return lines;
}

function trimLeadingBlankLines(lines: string[]): string[] {
  while (lines[0]?.trim() === "") {
    lines.shift();
  }
  return lines;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function timeoutForIteration(iteration: GoalIterationState, state: GoalLoopState, now: Date): number {
  if (!iteration.deadlineAt) {
    return state.limits.iterationTimeoutMs;
  }
  const remaining = Date.parse(iteration.deadlineAt) - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 1_000;
  }
  return Math.min(state.limits.iterationTimeoutMs, Math.max(1_000, Math.floor(remaining)));
}

function buildPreviousIterationContext(state: GoalLoopState): string {
  const previous = state.iterations.filter((iteration) => iteration.iteration < state.currentIteration);
  if (previous.length === 0) {
    return "";
  }

  return previous
    .map((iteration) => {
      const lines = [`Iteration ${iteration.iteration}: ${iteration.status}`];
      if (iteration.generatedTodo?.todoPath) {
        lines.push(`Generated TODO: ${iteration.generatedTodo.todoPath}`);
      }
      if (iteration.workerResult) {
        lines.push(`Worker result: ${iteration.workerResult.status} — ${iteration.workerResult.summary}`);
      }
      if (iteration.reviewerResult) {
        lines.push(`Reviewer: ${iteration.reviewerResult.decision} — ${iteration.reviewerResult.rationale}`);
        if (iteration.reviewerResult.remainingWork.length > 0) {
          lines.push("Remaining work:", ...iteration.reviewerResult.remainingWork.map((item) => `- ${item}`));
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function markdownFence(value: string, language: string): string {
  const ticks = longestBacktickRun(value) + 1;
  const fence = "`".repeat(Math.max(3, ticks));
  return `${fence}${language}\n${value.trim()}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GoalTodoGenerationError("TODO generation was aborted before producing a generated TODO.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
