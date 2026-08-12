/**
 * Versioned protocol schemas and the single validation adapter.
 *
 * All external data enters the bridge as `unknown` and is narrowed here.
 * Schema failures are converted to fixed messages that never echo payload
 * values; the original TypeBox error (which may embed rejected values) is
 * discarded at this boundary.
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
  BootstrapResult,
  CheckpointRequest,
  JournalEvent,
  ProjectResolution,
  Receipt,
  SearchHit,
} from "./types.js";

/** Fixed error for a payload rejected by a versioned schema. */
export class SchemaValidationError extends Error {
  readonly code = "SCHEMA_VALIDATION_ERROR" as const;

  constructor(readonly subject: string) {
    super(`invalid ${subject}: rejected by versioned schema; details redacted`);
    this.name = "SchemaValidationError";
  }
}

/**
 * Single validation adapter: parse an `unknown` value against a versioned
 * schema and return the narrowed static type, or throw a redacted
 * {@link SchemaValidationError}. Future modules must narrow external values
 * through this function rather than implementing their own validation.
 */
export function parseWithSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  subject: string,
): Static<T> {
  try {
    return Value.Parse(schema, value);
  } catch {
    throw new SchemaValidationError(subject);
  }
}

/**
 * Identifier pattern shared by opaque protocol identifiers.
 * Rejects path separators, traversal segments, whitespace, control
 * characters, and overlong values so identifiers stay safe as file names.
 */
export const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

/**
 * Vault-relative path pattern: relative, bounded, and free of traversal
 * segments and NUL bytes. Deep containment and symlink checks happen in the
 * path layer (`src/paths.ts`) before filesystem access.
 */
export const VAULT_PATH_PATTERN =
  "^(?!.*(?:^|/)\\.\\.(?:/|$))[^/\\u0000][^\\u0000]{0,1023}$";

export const VersionSchema = Type.Literal(1);
export const SessionIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: ID_PATTERN,
});
export const HostIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: ID_PATTERN,
});
export const ProjectIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: ID_PATTERN,
});
export const EventIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: ID_PATTERN,
});
export const HashHexSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const IsoTimestampSchema = Type.String({
  format: "date-time",
  maxLength: 64,
});
export const VaultPathSchema = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: VAULT_PATH_PATTERN,
});
/** Absolute POSIX working directory without NUL bytes. */
export const CwdSchema = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^/[^\\u0000]*$",
});
export const NoopReasonSchema = Type.Union([
  Type.Literal("trivial"),
  Type.Literal("lookup_only"),
  Type.Literal("no_new_knowledge"),
  Type.Literal("unverified"),
  Type.Literal("already_recorded"),
]);
export const ResolutionBasisSchema = Type.Union([
  Type.Literal("remote"),
  Type.Literal("portable_id"),
  Type.Literal("alias"),
  Type.Literal("local_override"),
  Type.Literal("exact_name"),
  Type.Literal("lexical"),
]);
export const UnresolvedReasonSchema = Type.Union([
  Type.Literal("no_git"),
  Type.Literal("no_match"),
  Type.Literal("unreadable"),
]);

export const KnowledgeSchema = Type.Object(
  {
    completed_tasks: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    decisions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    status_changes: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    blockers: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    reusable_learnings: Type.Array(
      Type.String({ minLength: 1, maxLength: 2000 }),
    ),
    next_steps: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export const EvidenceSchema = Type.Object(
  {
    commits: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    tests: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    deployments: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    observations: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export const TargetsSchema = Type.Object(
  {
    daily: Type.Boolean(),
    project: Type.Boolean(),
    landscape: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CheckpointSourceSchema = Type.Object(
  {
    agent: Type.Literal("prime-agent"),
    host_id: HostIdSchema,
    session_id: SessionIdSchema,
    cwd: CwdSchema,
  },
  { additionalProperties: false },
);

export const ProjectRefSchema = Type.Object(
  { id: ProjectIdSchema },
  { additionalProperties: false },
);

export const ApplyCheckpointSchema = Type.Object(
  {
    version: VersionSchema,
    kind: Type.Literal("apply"),
    source: CheckpointSourceSchema,
    project: ProjectRefSchema,
    knowledge: KnowledgeSchema,
    evidence: EvidenceSchema,
    targets: TargetsSchema,
  },
  { additionalProperties: false },
);

export const NoopCheckpointSchema = Type.Object(
  {
    version: VersionSchema,
    kind: Type.Literal("noop"),
    reason: NoopReasonSchema,
  },
  { additionalProperties: false },
);

export const CheckpointSchema = Type.Union([
  ApplyCheckpointSchema,
  NoopCheckpointSchema,
]);

export const AppliedReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("applied"),
    event_id: EventIdSchema,
    paths: Type.Array(VaultPathSchema),
    before_hashes: Type.Record(Type.String(), HashHexSchema),
    after_hashes: Type.Record(Type.String(), HashHexSchema),
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const DeferredConflictReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("deferred_conflict"),
    event_id: EventIdSchema,
    proposal_path: VaultPathSchema,
    conflict_paths: Type.Array(VaultPathSchema),
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const ReceiptSchema = Type.Union([
  AppliedReceiptSchema,
  DeferredConflictReceiptSchema,
]);

export const JournalEventSchema = Type.Union([
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("checkpoint"),
      event_id: EventIdSchema,
      created_at: IsoTimestampSchema,
      checkpoint: CheckpointSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("recover"),
      event_id: EventIdSchema,
      created_at: IsoTimestampSchema,
      recovered_event_ids: Type.Array(EventIdSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("rollback"),
      event_id: EventIdSchema,
      created_at: IsoTimestampSchema,
      target_event_id: EventIdSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ProjectResolutionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("resolved"),
      project_id: ProjectIdSchema,
      basis: ResolutionBasisSchema,
      note_path: Type.Union([VaultPathSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unresolved"),
      reason: UnresolvedReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("ambiguous"),
      candidates: Type.Array(VaultPathSchema),
    },
    { additionalProperties: false },
  ),
]);

export const BootstrapResultSchema = Type.Object(
  {
    version: VersionSchema,
    context: Type.String({ maxLength: 1_000_000 }),
    truncated: Type.Boolean(),
    estimated_tokens: Type.Integer({ minimum: 0 }),
    budget_tokens: Type.Integer({ minimum: 0 }),
    fragments: Type.Array(
      Type.Object(
        {
          section: Type.String({ minLength: 1, maxLength: 128 }),
          source_path: VaultPathSchema,
          included: Type.Boolean(),
          bytes: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    project: ProjectResolutionSchema,
  },
  { additionalProperties: false },
);

export const SearchHitSchema = Type.Object(
  {
    path: VaultPathSchema,
    title: Type.String({ maxLength: 1024 }),
    snippet: Type.String({ maxLength: 8000 }),
    score: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Parse a checkpoint request or throw a redacted validation error. */
export function parseCheckpoint(value: unknown): CheckpointRequest {
  return parseWithSchema(
    CheckpointSchema,
    value,
    "checkpoint",
  ) as CheckpointRequest;
}

/** Parse a receipt or throw a redacted validation error. */
export function parseReceipt(value: unknown): Receipt {
  return parseWithSchema(ReceiptSchema, value, "receipt") as Receipt;
}

/** Parse a journal event or throw a redacted validation error. */
export function parseJournalEvent(value: unknown): JournalEvent {
  return parseWithSchema(JournalEventSchema, value, "journal event") as JournalEvent;
}

/** Parse a project resolution or throw a redacted validation error. */
export function parseProjectResolution(value: unknown): ProjectResolution {
  return parseWithSchema(
    ProjectResolutionSchema,
    value,
    "project resolution",
  ) as ProjectResolution;
}

/** Parse a bootstrap result or throw a redacted validation error. */
export function parseBootstrapResult(value: unknown): BootstrapResult {
  return parseWithSchema(
    BootstrapResultSchema,
    value,
    "bootstrap result",
  ) as BootstrapResult;
}

/** Parse a search hit or throw a redacted validation error. */
export function parseSearchHit(value: unknown): SearchHit {
  return parseWithSchema(SearchHitSchema, value, "search hit") as SearchHit;
}

