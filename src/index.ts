import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runCoordinatorStub } from "./coordinator";
import { PiTodoCoordinatorParams } from "./types";

export default function registerPiCoordinatorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_todo_coordinator",
    label: "Pi TODO Coordinator",
    description: "Coordinate Pi TODO worker sessions from a TODO description. Currently a native stub.",
    parameters: PiTodoCoordinatorParams,
    async execute(_toolCallId, params) {
      const result = await runCoordinatorStub(params);

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
