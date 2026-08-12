/**
 * Public protocol types for the Resyst Vault Bridge core.
 *
 * Every external value (JSON, YAML, process messages, extension payloads)
 * enters the bridge as `unknown` and is narrowed through the versioned
 * schemas in {@link ./schemas.js}. The composite protocol types below are
 * derived from the schema static types (`StaticDecode`), so a schema and its
 * public type cannot drift apart. The branded string aliases are
 * compile-time markers whose runtime guarantees come from the schema
 * patterns applied in `src/schemas.ts`.
 */
import type {
  AppliedReceipt,
  DeferredConflictReceipt,
  FailedReceipt,
  NoopReceipt,
} from "./schemas.js";

/** Protocol version accepted by this bridge release. */
export const PROTOCOL_VERSION = 1 as const;

/** Version carried by every persisted and wire protocol record. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Opaque session identifier assigned by the host agent runtime. */
export type SessionId = string & { readonly __sessionId: unique symbol };

/** Opaque machine-local host identifier from local configuration. */
export type HostId = string & { readonly __hostId: unique symbol };

/** Stable portable project identifier from vault frontmatter or overrides. */
export type ProjectId = string & { readonly __projectId: unique symbol };

/** Opaque event identifier for journal, receipt, backup, and rollback records. */
export type EventId = string & { readonly __eventId: unique symbol };

/** Opaque evidence identifier cited by knowledge items. */
export type EvidenceId = string & { readonly __evidenceId: unique symbol };

/**
 * Idempotency key: SHA-256 of the canonical checkpoint data (Task 7),
 * exactly 64 lowercase hex characters, making journal events and receipts
 * idempotent.
 */
export type IdempotencyKey = string & { readonly __idempotencyKey: unique symbol };

/** Vault-relative POSIX note path; never absolute, never traverses upward. */
export type VaultPath = string & { readonly __vaultPath: unique symbol };

/** Lowercase hex-encoded SHA-256 content hash. */
export type HashHex = string & { readonly __hashHex: unique symbol };

/** Fixed ISO-8601 UTC timestamp emitted by the bridge. */
export type IsoTimestamp = string & { readonly __isoTimestamp: unique symbol };

/** Documented reasons an evaluated checkpoint explicitly records no write. */
export const NOOP_REASONS = [
  "trivial",
  "lookup_only",
  "no_new_knowledge",
  "unverified",
  "already_recorded",
] as const;

/** Reason carried by an explicit no-op checkpoint. */
export type NoopReason = (typeof NOOP_REASONS)[number];

/** How a project identifier was matched during resolution. */
export const RESOLUTION_BASIS = [
  "remote",
  "portable_id",
  "alias",
  "local_override",
  "exact_name",
  "lexical",
] as const;

/** Basis recorded for a resolved project. */
export type ResolutionBasis = (typeof RESOLUTION_BASIS)[number];

/** Reasons a project cannot be resolved. */
export const UNRESOLVED_REASONS = ["no_git", "no_match", "unreadable"] as const;

/** Reason recorded for an unresolved project. */
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/** Reasons an apply checkpoint is journaled as deferred. */
export const DEFER_REASONS = [
  "conflict",
  "ambiguous_project",
  "landscape_ambiguous",
] as const;

/** Reason recorded for an apply checkpoint that defers writeback. */
export type DeferReason = (typeof DEFER_REASONS)[number];

/** Fixed failure reasons recorded on failed receipts. */
export const FAIL_REASONS = [
  "lock_unavailable",
  "precondition_mismatch",
  "io_error",
  "invalid_state",
] as const;

/** Reason recorded on a failed receipt. */
export type FailReason = (typeof FAIL_REASONS)[number];

/** Receipt outcomes persisted under the vault receipts directory. */
export const RECEIPT_OUTCOMES = [
  "applied",
  "noop",
  "deferred_conflict",
  "failed",
  "rolled_back",
] as const;

/** Outcome carried by a persisted receipt. */
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

/** Search fields that can produce a match, recorded as matching provenance. */
export const SEARCH_MATCH_FIELDS = [
  "filename",
  "title",
  "alias",
  "wikilink",
  "content",
] as const;

/** Field recorded when a search hit matched. */
export type SearchMatchField = (typeof SEARCH_MATCH_FIELDS)[number];

/**
 * Outcome of a checkpoint evaluation. A pure result type: only receipts are
 * persisted, and each outcome kind is correlated to the exact receipt type
 * it produced (`applied` -> {@link AppliedReceipt}, `noop` ->
 * {@link NoopReceipt}, `deferred_conflict` ->
 * {@link DeferredConflictReceipt}, `failed` -> {@link FailedReceipt});
 * apply transitions use {@link ApplyTarget}, rollback transitions use
 * {@link RollbackTarget}.
 * `already_applied` references the original applied receipt without writing
 * a second one; `rolled_back` stays service-specific (rollback receipts).
 */
export type CheckpointOutcome =
  | { kind: "applied"; event_id: EventId; receipt: AppliedReceipt }
  | { kind: "noop"; event_id: EventId; receipt: NoopReceipt; reason: NoopReason }
  | {
      kind: "deferred_conflict";
      event_id: EventId;
      receipt: DeferredConflictReceipt;
    }
  | { kind: "failed"; event_id: EventId; receipt: FailedReceipt }
  | {
      kind: "already_applied";
      idempotency_key: IdempotencyKey;
      original_event_id: EventId;
      original_receipt: AppliedReceipt;
    }
  | {
      kind: "invalid";
      reason: "schema_rejected" | "unsupported_version" | "unknown_evidence_citation";
    };

// ---------------------------------------------------------------------------
// Composite protocol types, derived from the versioned schemas so the value
// contract and its validation can never drift apart.
// ---------------------------------------------------------------------------
export type {
  ApplyCheckpoint,
  AppliedReceipt,
  BootstrapFragment,
  BootstrapResult,
  CheckpointRequest,
  CheckpointSource,
  DeferredConflictReceipt,
  Evidence,
  EvidenceItem,
  FailedReceipt,
  JournalEvent,
  Knowledge,
  KnowledgeItem,
  NoopCheckpoint,
  NoopReceipt,
  ApplyTarget,
  ProjectRef,
  ProjectResolution,
  Receipt,
  RollbackTarget,
  RolledBackReceipt,
  SearchHit,
  Targets,
} from "./schemas.js";
