import type { Static } from "typebox";
import { Type } from "typebox";

export const PiTodoCoordinatorParams = Type.Object(
  {
    inputText: Type.String({ description: "TODO file content or coordinator instructions to process." }),
    commit: Type.Boolean({ description: "Whether the coordinator may commit completed worker changes." }),
  },
  { additionalProperties: false },
);

export type PiTodoCoordinatorInput = Static<typeof PiTodoCoordinatorParams>;

export interface PiTodoCoordinatorResult {
  status: "done" | "failed";
  message: string;
  summary: string;
  runId: string;
  runDir: string;
  todoPath: string;
  taskResultPath: string;
  totalTasks: number;
  completedTasks: number;
  attemptedTasks: number;
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
