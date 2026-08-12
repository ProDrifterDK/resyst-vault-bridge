/**
 * Versioned protocol schemas and the single validation adapter.
 *
 * All external data enters the bridge as `unknown` and is narrowed here.
 * Schema failures are converted to fixed messages that never echo payload
 * values; the original TypeBox error (which may embed rejected values) is
 * discarded at this boundary.
 *
 * Branded identifiers are attached with TypeBox codecs: `StaticDecode` of a
 * schema therefore carries the brand, and `Value.Decode` re-tags the value at
 * the single validation boundary. Composite protocol types are derived from
 * `StaticDecode` in this module and re-exported by `types.ts`, so parser
 * results need no unchecked casts.
 */
import { Codec, Type, type StaticDecode, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
  DeferReason,
  EvidenceId,
  EventId,
  FailReason,
  HashHex,
  HostId,
  IdempotencyKey,
  IsoTimestamp,
  NoopReason,
  ProjectId,
  ResolutionBasis,
  SearchMatchField,
  SessionId,
  UnresolvedReason,
  VaultPath,
} from "./types.js";

/** Fixed body of a schema-rejection message. */
export const SCHEMA_REJECTED_MESSAGE =
  "rejected by versioned schema; details redacted";

/** Fixed body of the evidence-citation cross-validation message. */
export const EVIDENCE_CITATION_ERROR_MESSAGE =
  "evidence citations must reference known evidence ids";

/** Error codes produced by the validation boundary. */
export type SchemaErrorCode =
  | "SCHEMA_VALIDATION_ERROR"
  | "EVIDENCE_CITATION_ERROR";

/** Fixed error for a payload rejected by a versioned schema. */
export class SchemaValidationError extends Error {
  constructor(
    readonly subject: string,
    message: string = `invalid ${subject}: ${SCHEMA_REJECTED_MESSAGE}`,
    readonly code: SchemaErrorCode = "SCHEMA_VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/**
 * Single validation adapter: check an `unknown` value against a versioned
 * schema, decode it to its branded static type, and throw a redacted
 * {@link SchemaValidationError} on failure. Future modules must narrow
 * external values through this function rather than implementing their own
 * validation.
 */
export function parseWithSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  subject: string,
): StaticDecode<T> {
  try {
    if (!Value.Check(schema, value)) {
      throw new SchemaValidationError(subject);
    }
    return Value.Decode(schema, value);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw error;
    }
    throw new SchemaValidationError(subject);
  }
}

/** Bidirectional compile-time equality between two types. */
type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;

/**
 * Identifier pattern shared by opaque protocol identifiers.
 * Rejects path separators, traversal segments, whitespace, control
 * characters, and overlong values so identifiers stay safe as file names.
 */
export const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

/**
 * Vault-relative path pattern for normalized POSIX Markdown and managed vault
 * paths: relative, forward slashes only, no dot/empty/dotdot segments, no
 * trailing or doubled slashes, no control characters, and bounded length.
 * Deep containment and symlink checks happen in the path layer
 * (`src/paths.ts`) before filesystem access.
 */
export const VAULT_PATH_PATTERN = String.raw`^(?!.*(?:^|/)\.\.?(?:/|$))(?!.*//)(?!/$)(?![\\/])[^\\/\u0000-\u001F\u007F][^\\\u0000-\u001F\u007F]{0,1023}$`;

export const VersionSchema = Type.Literal(1);

export const SessionIdSchema = Codec(
  Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): SessionId => value as SessionId)
  .Encode((value: SessionId): string => value);

export const HostIdSchema = Codec(
  Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): HostId => value as HostId)
  .Encode((value: HostId): string => value);

export const ProjectIdSchema = Codec(
  Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): ProjectId => value as ProjectId)
  .Encode((value: ProjectId): string => value);

export const EventIdSchema = Codec(
  Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): EventId => value as EventId)
  .Encode((value: EventId): string => value);

export const EvidenceIdSchema = Codec(
  Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): EvidenceId => value as EvidenceId)
  .Encode((value: EvidenceId): string => value);

export const IdempotencyKeySchema = Codec(
  Type.String({ minLength: 8, maxLength: 128, pattern: ID_PATTERN }),
)
  .Decode((value: string): IdempotencyKey => value as IdempotencyKey)
  .Encode((value: IdempotencyKey): string => value);

export const VaultPathSchema = Codec(
  Type.String({ minLength: 1, maxLength: 1024, pattern: VAULT_PATH_PATTERN }),
)
  .Decode((value: string): VaultPath => value as VaultPath)
  .Encode((value: VaultPath): string => value);

export const HashHexSchema = Codec(
  Type.String({ pattern: "^[0-9a-f]{64}$" }),
)
  .Decode((value: string): HashHex => value as HashHex)
  .Encode((value: HashHex): string => value);

export const IsoTimestampSchema = Codec(
  Type.String({ format: "date-time", maxLength: 64 }),
)
  .Decode((value: string): IsoTimestamp => value as IsoTimestamp)
  .Encode((value: IsoTimestamp): string => value);

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
export const DeferReasonSchema = Type.Union([
  Type.Literal("conflict"),
  Type.Literal("ambiguous_project"),
  Type.Literal("landscape_ambiguous"),
]);
export const FailReasonSchema = Type.Union([
  Type.Literal("lock_unavailable"),
  Type.Literal("precondition_mismatch"),
  Type.Literal("io_error"),
  Type.Literal("invalid_state"),
]);
export const SearchMatchFieldSchema = Type.Union([
  Type.Literal("filename"),
  Type.Literal("title"),
  Type.Literal("alias"),
  Type.Literal("wikilink"),
  Type.Literal("content"),
]);

// Compile-time bidirectional alignment between the types.ts const-array
// unions and the schema literal unions; each declaration fails the build if
// they drift apart.
export const _noopReasonAligned: AssertEqual<
  NoopReason,
  StaticDecode<typeof NoopReasonSchema>
> = true;
export const _resolutionBasisAligned: AssertEqual<
  ResolutionBasis,
  StaticDecode<typeof ResolutionBasisSchema>
> = true;
export const _unresolvedReasonAligned: AssertEqual<
  UnresolvedReason,
  StaticDecode<typeof UnresolvedReasonSchema>
> = true;
export const _deferReasonAligned: AssertEqual<
  DeferReason,
  StaticDecode<typeof DeferReasonSchema>
> = true;
export const _failReasonAligned: AssertEqual<
  FailReason,
  StaticDecode<typeof FailReasonSchema>
> = true;
export const _searchMatchFieldAligned: AssertEqual<
  SearchMatchField,
  StaticDecode<typeof SearchMatchFieldSchema>
> = true;

/** One factual item; `evidence` cites ids from the evidence collections. */
export const KnowledgeItemSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000 }),
    evidence: Type.Array(EvidenceIdSchema),
  },
  { additionalProperties: false },
);

export const KnowledgeSchema = Type.Object(
  {
    completed_tasks: Type.Array(KnowledgeItemSchema),
    decisions: Type.Array(KnowledgeItemSchema),
    status_changes: Type.Array(KnowledgeItemSchema),
    blockers: Type.Array(KnowledgeItemSchema),
    reusable_learnings: Type.Array(KnowledgeItemSchema),
    next_steps: Type.Array(KnowledgeItemSchema),
  },
  { additionalProperties: false },
);

/** One verifiable citation; `id` is referenced by knowledge items. */
export const EvidenceItemSchema = Type.Object(
  {
    id: EvidenceIdSchema,
    value: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const EvidenceSchema = Type.Object(
  {
    commits: Type.Array(EvidenceItemSchema),
    tests: Type.Array(EvidenceItemSchema),
    files: Type.Array(EvidenceItemSchema),
    deployments: Type.Array(EvidenceItemSchema),
    observations: Type.Array(EvidenceItemSchema),
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

/** One written file inside an applied transaction. */
export const ReceiptTargetSchema = Type.Object(
  {
    path: VaultPathSchema,
    /** Null when the file did not exist before the transaction (creation). */
    before_hash: Type.Union([HashHexSchema, Type.Null()]),
    after_hash: HashHexSchema,
  },
  { additionalProperties: false },
);

export const AppliedReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("applied"),
    event_id: EventIdSchema,
    idempotency_key: IdempotencyKeySchema,
    targets: Type.Array(ReceiptTargetSchema, { minItems: 1 }),
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const NoopReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("noop"),
    event_id: EventIdSchema,
    idempotency_key: IdempotencyKeySchema,
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const DeferredConflictReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("deferred_conflict"),
    event_id: EventIdSchema,
    idempotency_key: IdempotencyKeySchema,
    proposal_path: VaultPathSchema,
    conflict_paths: Type.Array(VaultPathSchema),
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const FailedReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("failed"),
    event_id: EventIdSchema,
    idempotency_key: IdempotencyKeySchema,
    reason: FailReasonSchema,
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const RolledBackReceiptSchema = Type.Object(
  {
    version: VersionSchema,
    outcome: Type.Literal("rolled_back"),
    event_id: EventIdSchema,
    idempotency_key: IdempotencyKeySchema,
    target_event_id: EventIdSchema,
    created_at: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const ReceiptSchema = Type.Union([
  AppliedReceiptSchema,
  NoopReceiptSchema,
  DeferredConflictReceiptSchema,
  FailedReceiptSchema,
  RolledBackReceiptSchema,
]);

export const _receiptOutcomeAligned: AssertEqual<
  import("./types.js").ReceiptOutcome,
  StaticDecode<typeof ReceiptSchema>["outcome"]
> = true;

export const JournalEventSchema = Type.Union([
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("apply"),
      event_id: EventIdSchema,
      idempotency_key: IdempotencyKeySchema,
      created_at: IsoTimestampSchema,
      checkpoint: ApplyCheckpointSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("noop"),
      event_id: EventIdSchema,
      idempotency_key: IdempotencyKeySchema,
      created_at: IsoTimestampSchema,
      checkpoint: NoopCheckpointSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("deferred"),
      event_id: EventIdSchema,
      idempotency_key: IdempotencyKeySchema,
      created_at: IsoTimestampSchema,
      checkpoint: ApplyCheckpointSchema,
      reason: DeferReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: VersionSchema,
      kind: Type.Literal("recover"),
      event_id: EventIdSchema,
      idempotency_key: IdempotencyKeySchema,
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
      idempotency_key: IdempotencyKeySchema,
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

/** Provenance of one bootstrap fragment: note, heading, mtime, size, truncation. */
export const BootstrapFragmentSchema = Type.Object(
  {
    section: Type.String({ minLength: 1, maxLength: 128 }),
    source_path: VaultPathSchema,
    heading: Type.Union([
      Type.String({ minLength: 1, maxLength: 512 }),
      Type.Null(),
    ]),
    modified_at: IsoTimestampSchema,
    char_count: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const BootstrapResultSchema = Type.Object(
  {
    version: VersionSchema,
    context: Type.String({ maxLength: 1_000_000 }),
    truncated: Type.Boolean(),
    estimated_tokens: Type.Integer({ minimum: 0 }),
    budget_tokens: Type.Integer({ minimum: 0 }),
    fragments: Type.Array(BootstrapFragmentSchema),
    project: ProjectResolutionSchema,
  },
  { additionalProperties: false },
);

export const SearchHitSchema = Type.Object(
  {
    path: VaultPathSchema,
    title: Type.String({ maxLength: 1024 }),
    heading: Type.Union([
      Type.String({ minLength: 1, maxLength: 512 }),
      Type.Null(),
    ]),
    modified_at: IsoTimestampSchema,
    snippet: Type.String({ maxLength: 8000 }),
    snippet_truncated: Type.Boolean(),
    matched_on: Type.Array(SearchMatchFieldSchema),
    score: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Derived protocol value types: single source of truth for the value
// contract. `types.ts` re-exports these.
// ---------------------------------------------------------------------------
export type CheckpointSource = StaticDecode<typeof CheckpointSourceSchema>;
export type KnowledgeItem = StaticDecode<typeof KnowledgeItemSchema>;
export type Knowledge = StaticDecode<typeof KnowledgeSchema>;
export type EvidenceItem = StaticDecode<typeof EvidenceItemSchema>;
export type Evidence = StaticDecode<typeof EvidenceSchema>;
export type Targets = StaticDecode<typeof TargetsSchema>;
export type ProjectRef = StaticDecode<typeof ProjectRefSchema>;
export type ApplyCheckpoint = StaticDecode<typeof ApplyCheckpointSchema>;
export type NoopCheckpoint = StaticDecode<typeof NoopCheckpointSchema>;
export type CheckpointRequest = StaticDecode<typeof CheckpointSchema>;
export type ReceiptTarget = StaticDecode<typeof ReceiptTargetSchema>;
export type AppliedReceipt = StaticDecode<typeof AppliedReceiptSchema>;
export type NoopReceipt = StaticDecode<typeof NoopReceiptSchema>;
export type DeferredConflictReceipt = StaticDecode<
  typeof DeferredConflictReceiptSchema
>;
export type FailedReceipt = StaticDecode<typeof FailedReceiptSchema>;
export type RolledBackReceipt = StaticDecode<typeof RolledBackReceiptSchema>;
export type Receipt = StaticDecode<typeof ReceiptSchema>;
export type JournalEvent = StaticDecode<typeof JournalEventSchema>;
export type ProjectResolution = StaticDecode<typeof ProjectResolutionSchema>;
export type BootstrapFragment = StaticDecode<typeof BootstrapFragmentSchema>;
export type BootstrapResult = StaticDecode<typeof BootstrapResultSchema>;
export type SearchHit = StaticDecode<typeof SearchHitSchema>;

/** Assert every cited evidence id exists in one of the evidence collections. */
function assertKnownEvidenceCitations(checkpoint: ApplyCheckpoint): void {
  const known = new Set<EvidenceId>();
  const evidenceCollections = [
    checkpoint.evidence.commits,
    checkpoint.evidence.tests,
    checkpoint.evidence.files,
    checkpoint.evidence.deployments,
    checkpoint.evidence.observations,
  ];
  for (const collection of evidenceCollections) {
    for (const item of collection) {
      known.add(item.id);
    }
  }
  const knowledgeCollections = [
    checkpoint.knowledge.completed_tasks,
    checkpoint.knowledge.decisions,
    checkpoint.knowledge.status_changes,
    checkpoint.knowledge.blockers,
    checkpoint.knowledge.reusable_learnings,
    checkpoint.knowledge.next_steps,
  ];
  for (const collection of knowledgeCollections) {
    for (const item of collection) {
      for (const cited of item.evidence) {
        if (!known.has(cited)) {
          throw new SchemaValidationError(
            "checkpoint",
            `invalid checkpoint: ${EVIDENCE_CITATION_ERROR_MESSAGE}`,
            "EVIDENCE_CITATION_ERROR",
          );
        }
      }
    }
  }
}

/** Parse a checkpoint request or throw a redacted validation error. */
export function parseCheckpoint(value: unknown): CheckpointRequest {
  const checkpoint = parseWithSchema(CheckpointSchema, value, "checkpoint");
  if (checkpoint.kind === "apply") {
    assertKnownEvidenceCitations(checkpoint);
  }
  return checkpoint;
}

/** Parse a receipt or throw a redacted validation error. */
export function parseReceipt(value: unknown): Receipt {
  return parseWithSchema(ReceiptSchema, value, "receipt");
}

/** Parse a journal event or throw a redacted validation error. */
export function parseJournalEvent(value: unknown): JournalEvent {
  return parseWithSchema(JournalEventSchema, value, "journal event");
}

/** Parse a project resolution or throw a redacted validation error. */
export function parseProjectResolution(value: unknown): ProjectResolution {
  return parseWithSchema(ProjectResolutionSchema, value, "project resolution");
}

/** Parse a bootstrap result or throw a redacted validation error. */
export function parseBootstrapResult(value: unknown): BootstrapResult {
  return parseWithSchema(BootstrapResultSchema, value, "bootstrap result");
}

/** Parse a search hit or throw a redacted validation error. */
export function parseSearchHit(value: unknown): SearchHit {
  return parseWithSchema(SearchHitSchema, value, "search hit");
}
