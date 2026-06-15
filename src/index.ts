import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runCoordinator } from "./coordinator.ts";
import { PiTodoCoordinatorParams } from "./types.ts";

export default function registerPiCoordinatorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_todo_coordinator",
    label: "Pi TODO Coordinator",
    description: "Coordinate Pi TODO worker sessions from a TODO description.",
    parameters: PiTodoCoordinatorParams,
    async execute(_toolCallId, params) {
      const result = await runCoordinator(params);

      return {
        content: [
          {
            type: "text" as const,
            text: result.message,
          },
        ],
        details: result,
      };
    },
  });
}
