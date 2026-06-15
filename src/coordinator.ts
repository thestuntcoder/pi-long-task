import type { PiTodoCoordinatorInput, PiTodoCoordinatorResult } from "./types";

export async function runCoordinatorStub(input: PiTodoCoordinatorInput): Promise<PiTodoCoordinatorResult> {
  return {
    status: "stub",
    message: "pi_todo_coordinator is registered; native coordinator behavior will be implemented in later TODOs.",
    inputTextLength: input.inputText.length,
    commit: input.commit,
  };
}
