import type { Static } from "typebox";
import { Type } from "typebox";

import type { SessionOutcome } from "./worker_session.ts";

export const PiTodoCoordinatorParams = Type.Object(
  {
    inputText: Type.String({ description: "TODO file content or coordinator instructions to process." }),
    commit: Type.Boolean({ description: "Whether the coordinator may commit completed worker changes." }),
  },
  { additionalProperties: false },
);

export type PiTodoCoordinatorInput = Static<typeof PiTodoCoordinatorParams>;

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

export interface PiTodoCoordinatorResult {
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
  commit: boolean;
  error?: string;
}
