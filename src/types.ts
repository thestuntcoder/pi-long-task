import type { Static } from "typebox";
import { Type } from "typebox";

import type { TaskProgressModel } from "./task_progress.ts";
import type { SessionOutcome } from "./worker_session.ts";

export const PiLongTaskParams = Type.Object(
  {
    inputText: Type.Optional(
      Type.String({
        description:
          "Optional TODO file content or the user's long-task instructions to process. Natural-language routing parses commit and goal separately.",
      }),
    ),
    commit: Type.Boolean({
      description:
        "Whether Pi Long Task may commit completed worker changes. Use true when the user asks for commits or committing as work progresses; otherwise use false.",
    }),
    goal: Type.Optional(
      Type.String({
        description: "Optional high-level goal or desired outcome for the long-task run.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const PiGoalTaskParams = Type.Object(
  {
    goal: Type.String({
      description:
        "High-level goal to achieve through repeated TODO generation, long-task execution, and reviewer iterations until complete or stopped by limits.",
    }),
    commit: Type.Optional(
      Type.Boolean({
        description:
          "Whether worker long tasks may commit completed TODO work during the goal loop. Defaults to true for goal loops.",
      }),
    ),
    maxIterations: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of generate → execute → review iterations before stopping.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Overall goal-loop timeout in milliseconds.",
      }),
    ),
    iterationTimeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Timeout budget in milliseconds for each generated TODO worker iteration.",
      }),
    ),
    reviewerTimeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Timeout budget in milliseconds for each reviewer session.",
      }),
    ),
    maxAttemptsPerTask: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum attempts for each TODO inside worker long-task runs.",
      }),
    ),
    maxBashTimeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum bash command timeout in milliseconds allowed in worker sessions.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type PiLongTaskInput = Static<typeof PiLongTaskParams>;
export type PiGoalTaskInput = Static<typeof PiGoalTaskParams>;

export type CoordinatorStatus = "done" | "partial" | "blocked" | "failed";

export interface CoordinatorCommitSummary {
  taskId: string;
  hash?: string;
  error?: string;
}

export interface CoordinatorRemainingTask {
  taskId: string;
  title: string;
  status: string;
}

export interface PiLongTaskResult {
  status: CoordinatorStatus;
  message: string;
  summary: string;
  runId: string;
  runDir: string;
  todoPath: string;
  resultPath: string;
  taskResultPath: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  attemptedTasks: number;
  remainingTasks: CoordinatorRemainingTask[];
  outcomes: SessionOutcome[];
  commits: CoordinatorCommitSummary[];
  attempts: Array<{
    taskId: string;
    title: string;
    attempt: number;
    reportedStatus: string;
    done: boolean;
    error?: string;
    commitHash?: string;
    commitError?: string;
    commitSkipped?: string;
  }>;
  taskProgress: TaskProgressModel;
  workerCostTotal: number;
  commit: boolean;
  goal?: string;
  error?: string;
}
