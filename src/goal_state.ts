import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GOAL_LOOP_STATE_SCHEMA_VERSION,
  type GoalIterationState,
  type GoalLoopState,
  type GoalLoopTraceEvent,
  validateGoalLoopState,
} from "./goal_loop.ts";
import { type GoalSpecification, validateGoalSpecification } from "./goal_spec.ts";

export const GOAL_STATE_FILE = "GOAL_STATE.json";
export const GOAL_TRACE_FILE = "GOAL_TRACE.jsonl";
export const GOAL_RESULT_FILE = "GOAL_RESULT.md";
export const GOAL_SPEC_FILE = "GOAL_SPEC.json";

export interface GoalStateStoreOptions {
  cwd?: string;
  goalRunId: string;
  goalRunDir?: string;
}

export interface GoalStateStorePaths {
  goalRunId: string;
  goalRunDir: string;
  statePath: string;
  tracePath: string;
  resultPath: string;
  goalSpecPath: string;
  iterationsDir: string;
}

export class GoalStateStore {
  readonly paths: GoalStateStorePaths;

  constructor(options: GoalStateStoreOptions) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const goalRunDir = options.goalRunDir ?? path.join(cwd, "tmp", "pi-goal-task", options.goalRunId);
    this.paths = {
      goalRunId: options.goalRunId,
      goalRunDir,
      statePath: path.join(goalRunDir, GOAL_STATE_FILE),
      tracePath: path.join(goalRunDir, GOAL_TRACE_FILE),
      resultPath: path.join(goalRunDir, GOAL_RESULT_FILE),
      goalSpecPath: path.join(goalRunDir, GOAL_SPEC_FILE),
      iterationsDir: path.join(goalRunDir, "iterations"),
    };
  }

  async ensureRunDir(): Promise<void> {
    await mkdir(this.paths.iterationsDir, { recursive: true });
  }

  async saveState(state: GoalLoopState): Promise<void> {
    validateGoalLoopState(state);
    await this.ensureRunDir();
    await atomicWriteFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async loadState(): Promise<GoalLoopState> {
    const text = await readFile(this.paths.statePath, "utf8");
    return validateGoalLoopState(JSON.parse(text));
  }

  async saveGoalSpecification(spec: GoalSpecification): Promise<void> {
    validateGoalSpecification(spec);
    await this.ensureRunDir();
    await atomicWriteFile(this.paths.goalSpecPath, `${JSON.stringify(spec, null, 2)}\n`);
  }

  async loadGoalSpecification(): Promise<GoalSpecification> {
    const text = await readFile(this.paths.goalSpecPath, "utf8");
    return validateGoalSpecification(JSON.parse(text));
  }

  async tryLoadGoalSpecification(): Promise<GoalSpecification | undefined> {
    try {
      return await this.loadGoalSpecification();
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async appendTrace(event: GoalLoopTraceEvent): Promise<void> {
    await this.ensureRunDir();
    await appendFile(this.paths.tracePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async appendNewTraceEvents(previousTraceLength: number, state: GoalLoopState): Promise<void> {
    const events = state.trace.slice(Math.max(0, previousTraceLength));
    for (const event of events) {
      await this.appendTrace(event);
    }
  }

  async initializeResult(state: GoalLoopState): Promise<void> {
    validateGoalLoopState(state);
    await this.ensureRunDir();
    const lines = [
      "# Pi Goal Task Result",
      "",
      `Run: ${state.goalRunId}`,
      `Goal: ${state.goal}`,
      `Started: ${state.startedAt}`,
      `State: ${this.paths.statePath}`,
      `Trace: ${this.paths.tracePath}`,
      `Goal specification: ${this.paths.goalSpecPath}`,
      "",
      "## Safety limits",
      "",
      `- Max iterations: ${state.limits.maxIterations}`,
      `- Run timeout: ${state.limits.timeoutMs}ms`,
      `- Iteration timeout: ${state.limits.iterationTimeoutMs}ms`,
      `- Reviewer timeout: ${state.limits.reviewerTimeoutMs}ms`,
      "",
    ];
    await writeFile(this.paths.resultPath, `${lines.join("\n")}\n`, "utf8");
  }

  async appendIterationResult(iteration: GoalIterationState): Promise<void> {
    await this.ensureRunDir();
    const lines = [
      "",
      `## Iteration ${iteration.iteration}`,
      "",
      `Status: ${iteration.status}`,
      `Started: ${iteration.startedAt}`,
      `Updated: ${iteration.updatedAt}`,
    ];
    if (iteration.deadlineAt) {
      lines.push(`Deadline: ${iteration.deadlineAt}`);
    }
    if (iteration.generatedTodo) {
      lines.push("", "### Generated TODO", "", `Path: ${iteration.generatedTodo.todoPath}`);
      if (iteration.generatedTodo.summary) {
        lines.push(`Summary: ${iteration.generatedTodo.summary}`);
      }
    }
    if (iteration.workerResult) {
      lines.push(
        "",
        "### Worker result",
        "",
        `Status: ${iteration.workerResult.status}`,
        `Summary: ${iteration.workerResult.summary}`,
      );
      if (iteration.workerResult.resultPath) {
        lines.push(`Result path: ${iteration.workerResult.resultPath}`);
      }
      if (iteration.workerResult.todoPath) {
        lines.push(`TODO path: ${iteration.workerResult.todoPath}`);
      }
      if (iteration.workerResult.taskResultPath) {
        lines.push(`Task result path: ${iteration.workerResult.taskResultPath}`);
      }
      if (iteration.workerResult.workerProgressPath) {
        lines.push(`Worker progress log: ${iteration.workerResult.workerProgressPath}`);
      }
      if (iteration.workerResult.error) {
        lines.push(`Error: ${iteration.workerResult.error}`);
      }
    }
    if (iteration.reviewerResult) {
      lines.push(
        "",
        "### Reviewer result",
        "",
        `Decision: ${iteration.reviewerResult.decision}`,
        `Complete: ${iteration.reviewerResult.complete ? "yes" : "no"}`,
        `Summary: ${iteration.reviewerResult.summary}`,
        `Rationale: ${iteration.reviewerResult.rationale}`,
      );
      if (iteration.reviewerResult.remainingWork.length > 0) {
        lines.push("", "Remaining work:", ...iteration.reviewerResult.remainingWork.map((item) => `- ${item}`));
      }
    }
    if (iteration.completion) {
      lines.push(
        "",
        "### Completion",
        "",
        `Status: ${iteration.completion.status}`,
        `Reason: ${iteration.completion.reason}`,
      );
    }
    await appendFile(this.paths.resultPath, `${lines.join("\n")}\n`, "utf8");
  }

  async writeIterationSnapshot(iteration: GoalIterationState): Promise<string> {
    const iterationDir = this.iterationDir(iteration.iteration);
    await mkdir(iterationDir, { recursive: true });
    const snapshotPath = path.join(iterationDir, "ITERATION_STATE.json");
    await atomicWriteFile(snapshotPath, `${JSON.stringify(iteration, null, 2)}\n`);
    return snapshotPath;
  }

  iterationDir(iteration: number): string {
    return path.join(this.paths.iterationsDir, String(iteration).padStart(2, "0"));
  }
}

export function goalStatePaths(options: GoalStateStoreOptions): GoalStateStorePaths {
  return new GoalStateStore(options).paths;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export function isGoalLoopState(value: unknown): value is GoalLoopState {
  try {
    return validateGoalLoopState(value).schemaVersion === GOAL_LOOP_STATE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
