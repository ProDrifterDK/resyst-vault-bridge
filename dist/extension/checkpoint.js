import { Type } from "typebox";
import { CHECKPOINT_OUTCOMES, CheckpointCommandSchema, CheckpointToolParametersSchema, } from "../checkpoint-contract.js";
import { parseWithSchema } from "../schemas.js";
export { CHECKPOINT_OUTCOMES, CheckpointCommandSchema as VaultCheckpointParametersSchema, };
const CheckpointResultSchema = Type.Object({ outcome: Type.Union(CHECKPOINT_OUTCOMES.map((outcome) => Type.Literal(outcome))) }, { additionalProperties: false });
export const CHECKPOINT_TOOL_UNAVAILABLE = "vault checkpoint unavailable";
export function checkpointReceipt(outcome) {
    return `vault checkpoint: ${outcome}`;
}
export function checkpointToolDefinition(execute) {
    return {
        name: "vault_checkpoint",
        label: "Vault Checkpoint",
        description: "Persist one normalized evaluation of completed work using trusted root-session context.",
        parameters: CheckpointToolParametersSchema,
        executionMode: "sequential",
        execute,
    };
}
export function validateCheckpointResult(value) {
    return parseWithSchema(CheckpointResultSchema, value, "checkpoint result");
}
