import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { longTaskInputTransform } from "./input_router.ts";
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
    taskProgress: result.taskProgress,
    workerCostTotal: result.workerCostTotal,
    summary: result.summary,
  };
}

export default function registerPiLongTaskExtension(pi: ExtensionAPI) {
  pi.on("input", (event) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }

    const transformed = longTaskInputTransform(event.text);
    if (!transformed) {
      return { action: "continue" as const };
    }

    return { action: "transform" as const, text: transformed };
  });

  pi.registerTool({
    name: "pi_long_task",
    label: "Pi Long Task",
    description:
      "Run long or multi-step coding tasks from a request or TODO plan. Use this when the user asks to run/start/handle a long task; set commit true only when they ask for commits or committing as work progresses.",
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
