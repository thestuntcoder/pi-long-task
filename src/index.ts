import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { renderLongTaskToolCall, renderLongTaskToolResult } from "./render.ts";
import { PiLongTaskParams } from "./types.ts";

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

export default function registerPiLongTaskExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_long_task",
    label: "Pi Long Task",
    description: "Break down and run long coding tasks from a request or TODO plan.",
    parameters: PiLongTaskParams,
    renderCall: renderLongTaskToolCall,
    renderResult: renderLongTaskToolResult,
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
