import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { renderCoordinatorToolCall, renderCoordinatorToolResult } from "./render.ts";
import { PiTodoCoordinatorParams } from "./types.ts";

function toolDetails(result: CoordinatorResult) {
  return {
    runId: result.runId,
    todoPath: result.todoPath,
    resultPath: result.resultPath,
    outcomes: result.outcomes,
    commits: result.commits,
    status: result.status,
    totalTasks: result.totalTasks,
    completedTasks: result.completedTasks,
    failedTasks: result.failedTasks,
    blockedTasks: result.blockedTasks,
    remainingTasks: result.remainingTasks,
    summary: result.summary,
  };
}

export default function registerPiCoordinatorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_todo_coordinator",
    label: "Pi TODO Coordinator",
    description: "Coordinate Pi TODO worker sessions from a TODO description.",
    parameters: PiTodoCoordinatorParams,
    renderCall: renderCoordinatorToolCall,
    renderResult: renderCoordinatorToolResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const publishProgress = (update: CoordinatorProgressUpdate) => {
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: update.message,
            },
          ],
          details: update,
        });
      };

      const result = await runCoordinator({
        ...params,
        cwd: ctx?.cwd,
        abortSignal: signal,
        onProgress: publishProgress,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: result.message,
          },
        ],
        details: toolDetails(result),
      };
    },
  });
}
