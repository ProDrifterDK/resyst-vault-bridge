/**
 * Public protocol types for the Resyst Vault Bridge core.
 *
 * Every external value (JSON, YAML, process messages, extension payloads)
 * enters the bridge as `unknown` and is narrowed through the versioned
 * schemas in {@link ./schemas.js}. The branded string aliases below are
 * compile-time markers only; their runtime guarantees come from the schema
 * patterns applied in `src/schemas.ts`.
 */

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

/** Vault-relative POSIX note path; never absolute, never traverses upward. */
export type VaultPath = string & { readonly __vaultPath: unique symbol };

/** Lowercase hex-encoded SHA-256 content hash. */
export type HashHex = string & { readonly __hashHex: unique symbol };

/** Fixed ISO-8601 UTC timestamp emitted by the bridge. */
export type IsoTimestamp = string & { readonly __isoTimestamp: unique symbol };

/** Provenance of a checkpoint submission. */
export interface CheckpointSource {
  /** Adapter that submitted the checkpoint; v1 supports the Prime Agent. */
  agent: "prime-agent";
  /** Opaque host identifier from local configuration. */
  host_id: HostId;
  /** Opaque root-session identifier. */
  session_id: SessionId;
  /** Absolute working directory of the agent turn. */
  cwd: string;
}

/** Claimed project reference carried by an apply checkpoint. */
export interface ProjectRef {
  /** Stable portable project identifier. */
  id: ProjectId;
}

/**
 * Facts the submitting agent chose to persist.
 * Entries are concise strings; citations live in the sibling evidence section.
 */
export interface Knowledge {
  completed_tasks: string[];
  decisions: string[];
  status_changes: string[];
  blockers: string[];
  reusable_learnings: string[];
  next_steps: string[];
}

/** Verifiable citations grouped by kind. */
export interface Evidence {
  commits: string[];
  tests: string[];
  files: string[];
  deployments: string[];
  observations: string[];
}

/** Destination selection for an apply checkpoint. */
export interface Targets {
  daily: boolean;
  project: boolean;
  landscape: boolean;
}

/** Explicit apply checkpoint requesting a journaled, recoverable writeback. */
export interface ApplyCheckpoint {
  version: ProtocolVersion;
  kind: "apply";
  source: CheckpointSource;
  project: ProjectRef;
  knowledge: Knowledge;
  evidence: Evidence;
  targets: Targets;
}

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

/** Explicit evaluation that records no write and distinguishes a missed checkpoint. */
export interface NoopCheckpoint {
  version: ProtocolVersion;
  kind: "noop";
  reason: NoopReason;
}

/** Versioned checkpoint request: either an apply or an explicit no-op. */
export type CheckpointRequest = ApplyCheckpoint | NoopCheckpoint;

/** Outcome of a checkpoint evaluation. */
export type CheckpointOutcome =
  | { kind: "applied"; event_id: EventId; receipt: Receipt }
  | { kind: "noop"; event_id: EventId; reason: NoopReason }
  | { kind: "deferred_conflict"; event_id: EventId; proposal_path: VaultPath }
  | { kind: "invalid"; reason: "schema_rejected" | "unsupported_version" };

/** Receipt written after files changed as part of an applied checkpoint. */
export interface AppliedReceipt {
  version: ProtocolVersion;
  outcome: "applied";
  event_id: EventId;
  /** Vault-relative paths written by the transaction. */
  paths: VaultPath[];
  /** SHA-256 of each written path before the transaction, keyed by vault-relative path. */
  before_hashes: Record<string, HashHex>;
  /** SHA-256 of each written path after the transaction, keyed by vault-relative path. */
  after_hashes: Record<string, HashHex>;
  created_at: IsoTimestamp;
}

/** Receipt written when a conflict defers writeback to an Inbox proposal. */
export interface DeferredConflictReceipt {
  version: ProtocolVersion;
  outcome: "deferred_conflict";
  event_id: EventId;
  /** Vault-relative proposal note created in the Inbox. */
  proposal_path: VaultPath;
  /** Vault-relative paths whose precondition check failed. */
  conflict_paths: VaultPath[];
  created_at: IsoTimestamp;
}

/** Discriminated receipt union persisted under the vault receipts directory. */
export type Receipt = AppliedReceipt | DeferredConflictReceipt;

/** Append-only journal record; every persisted mutation has one. */
export type JournalEvent =
  | {
      version: ProtocolVersion;
      kind: "checkpoint";
      event_id: EventId;
      created_at: IsoTimestamp;
      checkpoint: CheckpointRequest;
    }
  | {
      version: ProtocolVersion;
      kind: "recover";
      event_id: EventId;
      created_at: IsoTimestamp;
      recovered_event_ids: EventId[];
    }
  | {
      version: ProtocolVersion;
      kind: "rollback";
      event_id: EventId;
      created_at: IsoTimestamp;
      target_event_id: EventId;
    };

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

/**
 * Deterministic project resolution outcome.
 * Candidate retrieval never becomes an automatic selection; ambiguity is
 * reported and writeback falls back to the daily note.
 */
export type ProjectResolution =
  | {
      kind: "resolved";
      project_id: ProjectId;
      basis: ResolutionBasis;
      /** Vault-relative project note, when one exists. */
      note_path: VaultPath | null;
    }
  | { kind: "unresolved"; reason: UnresolvedReason }
  /** Redacted vault-relative candidate paths; equal candidates defer. */
  | { kind: "ambiguous"; candidates: VaultPath[] };

/** One provenance fragment of a bootstrap context. */
export interface BootstrapFragment {
  /** Fixed fragment section identifier. */
  section: string;
  /** Vault-relative source note of the fragment. */
  source_path: VaultPath;
  /** Whether the fragment fit inside the budget. */
  included: boolean;
  /** Bytes of the fragment body. */
  bytes: number;
}

/** Bounded context bundle produced for a root turn. */
export interface BootstrapResult {
  version: ProtocolVersion;
  /** Rendered context text. */
  context: string;
  /** True when the budget forced truncation. */
  truncated: boolean;
  /** Conservative character-based token estimate of the emitted context. */
  estimated_tokens: number;
  /** Configured token budget for this bootstrap. */
  budget_tokens: number;
  fragments: BootstrapFragment[];
  project: ProjectResolution;
}

/** One vault search result with explicit limits and truncation metadata. */
export interface SearchHit {
  /** Vault-relative note path. */
  path: VaultPath;
  /** Note title derived from the first heading or the file name. */
  title: string;
  /** Bounded excerpt around the match. */
  snippet: string;
  /** Lexical relevance score; higher is a better match. */
  score: number;
}
