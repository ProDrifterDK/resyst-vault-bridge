/** Thin Prime checkpoint tool contract; mutation logic stays in the core facade. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHECKPOINT_OUTCOMES,
  CheckpointCommandSchema,
  CheckpointToolParametersSchema,
  type CheckpointCommand,
  type CheckpointOutcome,
  type CheckpointResult,
  type CheckpointService,
  type CheckpointTrustedInput,
} from "../checkpoint-contract.js";
import { parseWithSchema } from "../schemas.js";

export {
  CHECKPOINT_OUTCOMES,
  CheckpointCommandSchema as VaultCheckpointParametersSchema,
};
export type {
  CheckpointCommand as VaultCheckpointCommandModel,
  CheckpointOutcome,
  CheckpointResult,
  CheckpointService,
  CheckpointTrustedInput,
};

const CheckpointResultSchema = Type.Object(
  { outcome: Type.Union(CHECKPOINT_OUTCOMES.map((outcome) => Type.Literal(outcome))) },
  { additionalProperties: false },
);
export const CHECKPOINT_TOOL_UNAVAILABLE = "vault checkpoint unavailable";
export function checkpointReceipt(outcome: CheckpointOutcome): string {
  return `vault checkpoint: ${outcome}`;
}
export interface CheckpointToolDetails {
  version: 1;
  outcome: "unavailable" | CheckpointOutcome;
}
export type CheckpointTool = ToolDefinition<typeof CheckpointToolParametersSchema, CheckpointToolDetails>;
export function checkpointToolDefinition(execute: CheckpointTool["execute"]): CheckpointTool {
  return {
    name: "vault_checkpoint",
    label: "Vault Checkpoint",
    description: "Persist one normalized evaluation of completed work using trusted root-session context.",
    parameters: CheckpointToolParametersSchema,
    executionMode: "sequential",
    execute,
  };
}
export function validateCheckpointResult(value: unknown): CheckpointResult {
  return parseWithSchema(CheckpointResultSchema, value, "checkpoint result");
}
