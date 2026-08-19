/** Bounded, adapter-neutral checkpoint command and result contract. */
import { Type } from "typebox";
import { EvidenceIdSchema, EvidenceItemSchema, TargetsSchema, VersionSchema, } from "./schemas.js";
const MAX_CHECKPOINT_ITEMS = 32;
const MAX_EVIDENCE_REFERENCES = 32;
const BoundedKnowledgeItemSchema = Type.Object({
    text: Type.String({ minLength: 1, maxLength: 2_000 }),
    evidence: Type.Array(EvidenceIdSchema, { maxItems: MAX_EVIDENCE_REFERENCES }),
}, { additionalProperties: false });
const BoundedKnowledgeSchema = Type.Object({
    completed_tasks: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    decisions: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    status_changes: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    blockers: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    reusable_learnings: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    next_steps: Type.Array(BoundedKnowledgeItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
}, { additionalProperties: false });
const BoundedEvidenceSchema = Type.Object({
    commits: Type.Array(EvidenceItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    tests: Type.Array(EvidenceItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    files: Type.Array(EvidenceItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    deployments: Type.Array(EvidenceItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
    observations: Type.Array(EvidenceItemSchema, { maxItems: MAX_CHECKPOINT_ITEMS }),
}, { additionalProperties: false });
/** Exact bounded model-controlled checkpoint command. */
export const CheckpointCommandSchema = Type.Union([
    Type.Object({
        version: VersionSchema,
        kind: Type.Literal("noop"),
        reason: Type.Union([
            Type.Literal("trivial"),
            Type.Literal("lookup_only"),
            Type.Literal("no_new_knowledge"),
            Type.Literal("unverified"),
            Type.Literal("already_recorded"),
        ]),
    }, { additionalProperties: false }),
    Type.Object({
        version: VersionSchema,
        kind: Type.Literal("apply"),
        knowledge: BoundedKnowledgeSchema,
        evidence: BoundedEvidenceSchema,
        targets: TargetsSchema,
    }, { additionalProperties: false }),
]);
/**
 * Provider-facing tool parameters. A bare `Type.Union` serializes as
 * `{ anyOf: [...] }` with no root `type`, which DeepSeek/Console Go reject
 * ("schema must be a JSON Schema of 'type: \"object\"'"). This flattened
 * object is only the wire shape; strict discriminated-union validation
 * still happens via `CheckpointCommandSchema` at execution time.
 */
export const CheckpointToolParametersSchema = Type.Object({
    version: VersionSchema,
    kind: Type.Union([Type.Literal("noop"), Type.Literal("apply")]),
    reason: Type.Optional(Type.Union([
        Type.Literal("trivial"),
        Type.Literal("lookup_only"),
        Type.Literal("no_new_knowledge"),
        Type.Literal("unverified"),
        Type.Literal("already_recorded"),
    ])),
    knowledge: Type.Optional(BoundedKnowledgeSchema),
    evidence: Type.Optional(BoundedEvidenceSchema),
    targets: Type.Optional(TargetsSchema),
}, { additionalProperties: false });
export const CHECKPOINT_OUTCOMES = [
    "invalid",
    "failed",
    "deferred",
    "applied",
    "noop",
    "already_applied",
];
