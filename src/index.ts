import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { runCoordinator, type CoordinatorProgressUpdate, type CoordinatorResult } from "./coordinator.ts";
import { longTaskInputTransform } from "./input_router.ts";
import { renderLongTaskToolCall, renderLongTaskToolResult } from "./render.ts";
import { PiLongTaskParams } from "./types.ts";

export function createWorkerCostAccumulator() {
  let pendingWorkerCostTotal = 0;

  return {
    add(cost: number): void {
      const value = finiteNonNegativeNumber(cost);
      if (value && value > 0) {
        pendingWorkerCostTotal += value;
      }
    },
    applyToAssistantMessage(message: AssistantMessage): AssistantMessage | undefined {
      if (pendingWorkerCostTotal <= 0) {
        return undefined;
      }

      const replacement = addWorkerCostToAssistantMessage(message, pendingWorkerCostTotal);
      if (replacement) {
        pendingWorkerCostTotal = 0;
      }
      return replacement;
    },
  };
}

export function addWorkerCostToAssistantMessage(
  message: AssistantMessage,
  workerCostTotal: number,
): AssistantMessage | undefined {
  const workerCost = finiteNonNegativeNumber(workerCostTotal);
  if (!workerCost || workerCost <= 0) {
    return undefined;
  }

  return {
    ...message,
    usage: {
      ...message.usage,
      cost: {
        ...message.usage.cost,
        total: message.usage.cost.total + workerCost,
      },
    },
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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
  const workerCostAccumulator = createWorkerCostAccumulator();

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return undefined;
    }

    const message = workerCostAccumulator.applyToAssistantMessage(event.message);
    return message ? { message } : undefined;
  });

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
      workerCostAccumulator.add(result.workerCostTotal);

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
