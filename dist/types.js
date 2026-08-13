/** Protocol version accepted by this bridge release. */
export const PROTOCOL_VERSION = 1;
/** Documented reasons an evaluated checkpoint explicitly records no write. */
export const NOOP_REASONS = [
    "trivial",
    "lookup_only",
    "no_new_knowledge",
    "unverified",
    "already_recorded",
];
/** How a project identifier was matched during resolution. */
export const RESOLUTION_BASIS = [
    "remote",
    "portable_id",
    "alias",
    "local_override",
    "exact_name",
    "lexical",
];
/** Reasons a project cannot be resolved. */
export const UNRESOLVED_REASONS = ["no_git", "no_match", "unreadable"];
/** Reasons an apply checkpoint is journaled as deferred. */
export const DEFER_REASONS = [
    "conflict",
    "ambiguous_project",
    "landscape_ambiguous",
];
/** Fixed failure reasons recorded on failed receipts. */
export const FAIL_REASONS = [
    "lock_unavailable",
    "precondition_mismatch",
    "io_error",
    "invalid_state",
];
/** Receipt outcomes persisted under the vault receipts directory. */
export const RECEIPT_OUTCOMES = [
    "applied",
    "noop",
    "deferred_conflict",
    "failed",
    "rolled_back",
];
/** Search fields that can produce a match, recorded as matching provenance. */
export const SEARCH_MATCH_FIELDS = [
    "filename",
    "title",
    "alias",
    "wikilink",
    "content",
];
