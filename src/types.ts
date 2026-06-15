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
  status: "stub";
  message: string;
  inputTextLength: number;
  commit: boolean;
}
