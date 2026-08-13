/**
 * Root-session checkpoint state.
 *
 * This module is deliberately independent of the Prime Agent host.  It owns
 * only the small, versioned state record, its pure transitions, the effect
 * observation matrix, and the machine-local pending copy.  Host payloads and
 * persisted JSON enter through the same bounded validation boundary; errors
 * never contain paths, session identifiers, tool arguments, or raw Node
 * messages.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalLock, type LockHandle } from "../lock.js";
import { CHECKPOINT_OUTCOMES, type CheckpointOutcome } from "../checkpoint-contract.js";

/** Custom-entry type used for transcript mirrors. */
export const CHECKPOINT_STATE_CUSTOM_TYPE =
  "resyst-vault.checkpoint-state" as const;

/** The only state-record version currently accepted. */
export const CHECKPOINT_STATE_VERSION = 1 as const;

/** Opaque session ids share the protocol identifier budget. */
export const MAX_CHECKPOINT_SESSION_ID_LENGTH = 128;

/** Maximum revision which can safely be incremented once. */
export const MAX_CHECKPOINT_REVISION = Number.MAX_SAFE_INTEGER - 1;

/** Maximum UTF-8 bytes accepted for a local state record. */
export const MAX_CHECKPOINT_STATE_RECORD_BYTES = 16 * 1024;

/** Alias retained for callers that name the persisted-record budget directly. */
export const MAX_PENDING_STATE_BYTES = MAX_CHECKPOINT_STATE_RECORD_BYTES;

/** Maximum number of transcript mirrors considered during reconstruction. */
export const MAX_CHECKPOINT_MIRRORS = 128;

/** Maximum number of remembered tool-call ids. */
export const MAX_EFFECT_CALL_IDS = 1_024;

/** Maximum configured tool-name length. */
export const MAX_EFFECT_TOOL_NAME_LENGTH = 256;

/** Maximum shell command length inspected by the effect matrix. */
export const MAX_EFFECT_COMMAND_LENGTH = 8_192;

/** Fixed, redacted error for every invalid or unavailable state operation. */
const CHECKPOINT_STATE_ERROR_MESSAGE =
  "checkpoint state is invalid; details redacted";

/** Error categories are diagnostic-safe and contain no caller data. */
export type CheckpointStateErrorCode =
  | "invalid_state"
  | "io_error"
  | "record_too_large"
  | "utf8_invalid";

/**
 * Fixed error boundary for state validation and machine-local persistence.
 * The optional code is a stable enum, never a raw filesystem error or path.
 */
export class CheckpointStateError extends Error {
  readonly code: CheckpointStateErrorCode;

  constructor(code: CheckpointStateErrorCode = "invalid_state") {
    super(CHECKPOINT_STATE_ERROR_MESSAGE);
    this.name = "CheckpointStateError";
    this.code = code;
  }
}

/** States carried by one session's checkpoint marker. */
export const CHECKPOINT_STATES = [
  "clean",
  "substantial_pending",
  "evaluation_pending",
  "evaluating",
  "evaluated",
] as const;

export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

/** Exact bounded record mirrored to the transcript and stored locally. */
export interface CheckpointStateRecord {
  version: typeof CHECKPOINT_STATE_VERSION;
  session_id: string;
  revision: number;
  state: CheckpointState;
  substantial: boolean;
  uncertainty: boolean;
  checkpoint_seen: boolean;
  updated_at: string;
}

/** Pure reducer events. */
export type CheckpointStateEvent =
  | { kind: "substantial" }
  | { kind: "uncertain" }
  | { kind: "begin_evaluation" }
  | { kind: "evaluation_incomplete" }
  | { kind: "evaluation_completed" }
  | { kind: "checkpoint_outcome"; outcome: CheckpointOutcome; basis_revision: number };

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const RECORD_KEYS = [
  "version",
  "session_id",
  "revision",
  "state",
  "substantial",
  "uncertainty",
  "checkpoint_seen",
  "updated_at",
] as const;
const EVENT_KINDS = [
  "substantial",
  "uncertain",
  "begin_evaluation",
  "evaluation_incomplete",
  "evaluation_completed",
  "checkpoint_outcome",
] as const;
const BRIDGE_TOOL_NAMES = new Set([
  "vault_search",
  "vault_read",
  "vault_checkpoint",
]);
const HOST_READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

function invalidState(code: CheckpointStateErrorCode = "invalid_state"): CheckpointStateError {
  return new CheckpointStateError(code);
}

function safeArrayKind(value: unknown): "array" | "not_array" | "invalid" {
  try { return Array.isArray(value) ? "array" : "not_array"; }
  catch { return "invalid"; }
}
function safeArray(value: unknown): value is unknown[] {
  try { return Array.isArray(value); }
  catch { return false; }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || safeArrayKind(value) !== "not_array") {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Read a data property without invoking a hostile getter.  State boundaries
 * accept ordinary JSON-like own data properties only.
 */
function ownDataProperty(
  value: Record<string, unknown>,
  key: string,
): { present: boolean; value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { present: false, value: undefined };
    }
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false, value: undefined };
  }
}

function exactOwnKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  try {
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length !== 0 || names.length !== allowed.length) return false;
    const allowedSet = new Set(allowed);
    return names.every((name) => {
      if (!allowedSet.has(name)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function boundedSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHECKPOINT_SESSION_ID_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAX_CHECKPOINT_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  );
}

function boundedTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !UTC_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  // Date parsing normalizes impossible calendar values (for example, the
  // thirty-second day of a month).  Compare against a canonical UTC form so
  // those values cannot enter a persisted record.
  const canonical = parsed.toISOString();
  const expected = value.includes(".")
    ? canonical
    : `${canonical.slice(0, 19)}Z`;
  return expected === value;
}

function flagsForState(state: CheckpointState): {
  substantial: boolean;
  uncertainty: boolean;
  checkpoint_seen: boolean;
} {
  return {
    substantial: state === "substantial_pending",
    uncertainty: state === "evaluation_pending" || state === "evaluating",
    checkpoint_seen: state === "evaluated",
  };
}

function isCheckpointState(value: unknown): value is CheckpointState {
  return typeof value === "string" && CHECKPOINT_STATES.includes(value as CheckpointState);
}

function isCheckpointOutcome(value: unknown): value is CheckpointOutcome {
  return typeof value === "string" && CHECKPOINT_OUTCOMES.includes(value as CheckpointOutcome);
}

function canonicalRecord(
  sessionId: string,
  revision: number,
  state: CheckpointState,
  updatedAt: string,
): CheckpointStateRecord {
  if (!boundedSessionId(sessionId) || !Number.isSafeInteger(revision) || revision < 0 || revision > MAX_CHECKPOINT_REVISION) {
    throw invalidState();
  }
  if (!boundedTimestamp(updatedAt)) throw invalidState();
  const flags = flagsForState(state);
  return {
    version: CHECKPOINT_STATE_VERSION,
    session_id: sessionId,
    revision,
    state,
    substantial: flags.substantial,
    uncertainty: flags.uncertainty,
    checkpoint_seen: flags.checkpoint_seen,
    updated_at: updatedAt,
  };
}

/**
 * Validate and canonicalize a persisted or mirrored record.  Unknown keys,
 * accessors, prototype-shaped values, inconsistent derived flags, invalid
 * timestamps, and oversized scalar fields are rejected with one fixed error.
 */
export function parseCheckpointStateRecord(value: unknown): CheckpointStateRecord {
  if (!isPlainRecord(value) || !exactOwnKeys(value, RECORD_KEYS)) {
    throw invalidState();
  }
  const version = ownDataProperty(value, "version");
  const sessionId = ownDataProperty(value, "session_id");
  const revision = ownDataProperty(value, "revision");
  const state = ownDataProperty(value, "state");
  const substantial = ownDataProperty(value, "substantial");
  const uncertainty = ownDataProperty(value, "uncertainty");
  const checkpointSeen = ownDataProperty(value, "checkpoint_seen");
  const updatedAt = ownDataProperty(value, "updated_at");
  if (
    !version.present ||
    !sessionId.present ||
    !revision.present ||
    !state.present ||
    !substantial.present ||
    !uncertainty.present ||
    !checkpointSeen.present ||
    !updatedAt.present ||
    version.value !== CHECKPOINT_STATE_VERSION ||
    !boundedSessionId(sessionId.value) ||
    typeof revision.value !== "number" ||
    !Number.isSafeInteger(revision.value) ||
    revision.value < 0 ||
    revision.value > MAX_CHECKPOINT_REVISION ||
    !isCheckpointState(state.value) ||
    typeof substantial.value !== "boolean" ||
    typeof uncertainty.value !== "boolean" ||
    typeof checkpointSeen.value !== "boolean" ||
    !boundedTimestamp(updatedAt.value)
  ) {
    throw invalidState();
  }
  const flags = flagsForState(state.value);
  if (
    substantial.value !== flags.substantial ||
    uncertainty.value !== flags.uncertainty ||
    checkpointSeen.value !== flags.checkpoint_seen
  ) {
    throw invalidState();
  }
  return {
    version: CHECKPOINT_STATE_VERSION,
    session_id: sessionId.value,
    revision: revision.value,
    state: state.value,
    substantial: flags.substantial,
    uncertainty: flags.uncertainty,
    checkpoint_seen: flags.checkpoint_seen,
    updated_at: updatedAt.value,
  };
}

/** Boolean validation companion for callers that do not want an exception. */
export function isCheckpointStateRecord(value: unknown): value is CheckpointStateRecord {
  try {
    parseCheckpointStateRecord(value);
    return true;
  } catch {
    return false;
  }
}

/** Alias using the terminology used by persistence callers. */
export const validateCheckpointStateRecord = isCheckpointStateRecord;

/** Create a clean record with no inherited state. */
export function initialCheckpointRecord(
  sessionId: string,
  now: string,
): CheckpointStateRecord {
  if (!boundedSessionId(sessionId) || !boundedTimestamp(now)) throw invalidState();
  return canonicalRecord(sessionId, 0, "clean", now);
}

function parseStateEvent(value: unknown): CheckpointStateEvent {
  if (!isPlainRecord(value)) throw invalidState();
  const kind = ownDataProperty(value, "kind");
  if (!kind.present || typeof kind.value !== "string" || !EVENT_KINDS.includes(kind.value as (typeof EVENT_KINDS)[number])) {
    throw invalidState();
  }
  if (kind.value === "checkpoint_outcome") {
    if (!exactOwnKeys(value, ["kind", "outcome", "basis_revision"])) throw invalidState();
    const outcome = ownDataProperty(value, "outcome");
    const basis = ownDataProperty(value, "basis_revision");
    if (
      !outcome.present || !isCheckpointOutcome(outcome.value) ||
      !basis.present || typeof basis.value !== "number" ||
      !Number.isSafeInteger(basis.value) || basis.value < 0 || basis.value > MAX_CHECKPOINT_REVISION
    ) throw invalidState();
    return { kind: "checkpoint_outcome", outcome: outcome.value, basis_revision: basis.value };
  }
  if (!exactOwnKeys(value, ["kind"])) throw invalidState();
  if (kind.value === "substantial") return { kind: "substantial" };
  if (kind.value === "uncertain") return { kind: "uncertain" };
  if (kind.value === "begin_evaluation") return { kind: "begin_evaluation" };
  if (kind.value === "evaluation_incomplete") return { kind: "evaluation_incomplete" };
  return { kind: "evaluation_completed" };
}

function stateAfterEvent(
  current: CheckpointState,
  currentRevision: number,
  event: CheckpointStateEvent,
): CheckpointState {
  switch (event.kind) {
    case "substantial":
      // Once uncertainty is observed it dominates a later substantial signal;
      // the evaluator must still inspect the whole turn.
      return current === "evaluation_pending" || current === "evaluating"
        ? "evaluation_pending"
        : "substantial_pending";
    case "uncertain":
      return "evaluation_pending";
    case "begin_evaluation":
      return current === "substantial_pending" || current === "evaluation_pending"
        ? "evaluating"
        : current;
    case "evaluation_incomplete":
      return current === "evaluating" ? "evaluation_pending" : current;
    case "evaluation_completed":
      return current === "substantial_pending" ||
        current === "evaluation_pending" ||
        current === "evaluating"
        ? "evaluated"
        : current;
    case "checkpoint_outcome":
      if (
        event.basis_revision !== currentRevision &&
        (event.outcome === "applied" || event.outcome === "noop" || event.outcome === "already_applied")
      ) return current;
      return event.outcome === "applied" ||
        event.outcome === "noop" ||
        event.outcome === "already_applied"
        ? "evaluated"
        : "evaluation_pending";
  }
}

/**
 * Pure state transition.  The input record and event are never mutated and
 * the returned record always has coherent derived flags and one new revision.
 */
export function reduceCheckpointState(
  record: CheckpointStateRecord,
  event: CheckpointStateEvent,
  now: string,
): CheckpointStateRecord {
  const current = parseCheckpointStateRecord(record);
  const parsedEvent = parseStateEvent(event);
  if (!boundedTimestamp(now)) throw invalidState();
  if (current.revision >= MAX_CHECKPOINT_REVISION) throw invalidState();
  return canonicalRecord(
    current.session_id,
    current.revision + 1,
    stateAfterEvent(current.state, current.revision, parsedEvent),
    now,
  );
}

/** Effect classification returned by {@link EffectTracker.observe}. */
export type EffectKind = "substantial" | "uncertain" | "ignore";

/** Narrow effect observation accepted from a host tool callback. */
export interface EffectObservation {
  tool_call_id: string;
  tool_name: string;
  is_error: boolean;
  input: unknown;
}

export interface EffectTrackerOptions {
  /** Successful tools in this set are treated as substantial. */
  substantialTools?: readonly string[];
  /** Maximum call ids retained for deduplication. */
  maxCallIds?: number;
}

function boundedToolName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EFFECT_TOOL_NAME_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAX_EFFECT_TOOL_NAME_LENGTH &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function boundedCallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    Buffer.byteLength(value, "utf8") <= 1024 &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function boundedCommand(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EFFECT_COMMAND_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAX_EFFECT_COMMAND_LENGTH &&
    !value.includes("\u0000")
  );
}

function observationProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

function commandProperty(value: unknown): unknown {
  if (!isPlainRecord(value)) return undefined;
  return observationProperty(value, "command");
}

const READ_ONLY_EXECUTABLES = new Set([
  "cat",
  "cut",
  "diff",
  "echo",
  "file",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "pwd",
  "realpath",
  "rg",
  "sort",
  "stat",
  "tail",
  "test",
  "true",
  "type",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const MUTATING_EXECUTABLES = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "ln",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "rmdir",
  "tee",
  "touch",
  "truncate",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "cat-file",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "fetch",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
]);

function firstCommandWord(segment: string): string | null {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return null;
  const assignmentStripped = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/u, "");
  const words = assignmentStripped.match(/^(?:'[^']*'|"[^"]*"|\S+)/u);
  if (words === null || words[0] === undefined) return null;
  return words[0].replace(/^['"]|['"]$/gu, "").toLowerCase();
}

function classifyBashSegment(segment: string): EffectKind {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return "ignore";
  // Output redirection is an unambiguous mutation.  Input redirection is
  // allowed to remain conservative through the executable classification.
  if (/(?:^|[^<])>{1,2}|\d>{1,2}/u.test(trimmed)) return "substantial";
  if (trimmed.includes("$(`") || trimmed.includes("$(") || trimmed.includes("`")) {
    return "uncertain";
  }
  const first = firstCommandWord(trimmed);
  if (first === null) return "uncertain";
  if (first === "git") {
    const separator = trimmed.search(/\s/u);
    if (separator < 0) return "ignore";
    const remainder = trimmed.slice(separator).trim();
    const [subcommand = "", ...arguments_] = remainder.split(/\s+/u);
    const gitSubcommand = subcommand.toLowerCase();
    const argumentsText = arguments_.join(" ");
    if (gitSubcommand === "branch") {
      return arguments_.length === 0 || /(?:^|\s)(?:-a|--all|-l|--list|-r|--remotes|-v|--verbose)(?:\s|$)/u.test(argumentsText)
        ? "ignore"
        : "substantial";
    }
    if (gitSubcommand === "remote") {
      return arguments_.length === 0 || /^(?:-v|--verbose|show|get-url)(?:\s|$)/u.test(argumentsText)
        ? "ignore"
        : "substantial";
    }
    if (READ_ONLY_GIT_SUBCOMMANDS.has(gitSubcommand)) return "ignore";
    if (MUTATING_GIT_SUBCOMMANDS.has(gitSubcommand)) {
      if (gitSubcommand === "tag" && /(?:^|\s)(?:-l|--list)(?:\s|$)/u.test(remainder)) return "ignore";
      return "substantial";
    }
    return "uncertain";
  }
  if (first === "sudo" || first === "env") {
    const rest = trimmed.replace(/^(?:sudo|env)\s+/iu, "");
    return classifyBashSegment(rest);
  }
  if (first === "sed") return /(?:^|\s)(?:-i(?:[^\s]*)?|--in-place(?:=[^\s]*)?)(?:\s|$)/u.test(trimmed) ? "substantial" : "ignore";
  if (first === "find") {
    if (/(?:^|\s)-delete(?:\s|$)/u.test(trimmed)) return "substantial";
    if (/(?:^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/u.test(trimmed)) return "uncertain";
    return "ignore";
  }
  if (MUTATING_EXECUTABLES.has(first)) return "substantial";
  if (READ_ONLY_EXECUTABLES.has(first)) return "ignore";
  if (first === "deploy" || first === "release" || first === "terraform" || first === "kubectl") {
    const lower = trimmed.toLowerCase();
    if (/\b(?:plan|validate|get|describe|version|diff)\b/u.test(lower)) return "ignore";
    return "substantial";
  }
  // Package managers and build/release commands are known to mutate local or
  // remote state; arbitrary scripts remain uncertainty rather than a claim.
  if (first === "npm" || first === "pnpm" || first === "yarn" || first === "make") {
    const lower = trimmed.toLowerCase();
    if (/\b(?:--version|version|help|test|run\s+(?:test|lint|check))\b/u.test(lower)) {
      return "uncertain";
    }
    return "substantial";
  }
  return "uncertain";
}

function classifyBash(command: unknown): EffectKind {
  if (!boundedCommand(command)) return "uncertain";
  // Any shell operator is split into independently classified segments.  A
  // single mutation wins; an unknown segment wins over an all-read-only turn.
  const segments = command.split(/&&|\|\||[;|\n]/u);
  let uncertain = false;
  for (const segment of segments) {
    const result = classifyBashSegment(segment);
    if (result === "substantial") return "substantial";
    if (result === "uncertain") uncertain = true;
  }
  return uncertain ? "uncertain" : "ignore";
}

/**
 * Bounded, fail-closed effect matrix.  Only call ids are retained; tool
 * arguments and command text are inspected transiently and never persisted.
 */
export class EffectTracker {
  private readonly seenCallIds = new Set<string>();
  private readonly substantialTools: ReadonlySet<string>;
  private readonly maxCallIds: number;

  constructor(options: EffectTrackerOptions = {}) {
    const configuredMax = options.maxCallIds;
    this.maxCallIds = configuredMax === undefined
      ? MAX_EFFECT_CALL_IDS
      : Number.isSafeInteger(configuredMax) && configuredMax > 0 && configuredMax <= MAX_EFFECT_CALL_IDS
        ? configuredMax
        : MAX_EFFECT_CALL_IDS;
    const names = new Set<string>();
    const configured = options.substantialTools;
    if (configured !== undefined) {
      const boundedCount = Math.min(configured.length, MAX_EFFECT_CALL_IDS);
      for (let index = 0; index < boundedCount; index += 1) {
        const name = configured[index];
        if (boundedToolName(name)) names.add(name);
      }
    }
    this.substantialTools = names;
  }

  observe(observation: unknown): EffectKind {
    if (!isPlainRecord(observation)) return "uncertain";
    const callId = observationProperty(observation, "tool_call_id");
    if (boundedCallId(callId)) {
      if (this.seenCallIds.has(callId)) return "ignore";
      this.remember(callId);
    } else {
      return "uncertain";
    }

    const toolName = observationProperty(observation, "tool_name");
    const isError = observationProperty(observation, "is_error");
    const input = observationProperty(observation, "input");
    if (!boundedToolName(toolName) || typeof isError !== "boolean") return "uncertain";
    if (isError) return "ignore";
    if (BRIDGE_TOOL_NAMES.has(toolName) || HOST_READ_TOOL_NAMES.has(toolName)) return "ignore";
    if (this.substantialTools.has(toolName) || toolName === "edit") return "substantial";
    if (toolName === "bash") return classifyBash(commandProperty(input));
    return "uncertain";
  }

  /** Number of retained ids, exposed without exposing any ids themselves. */
  size(): number {
    return this.seenCallIds.size;
  }

  /** Clear only the bounded deduplication memory. */
  clear(): void {
    this.seenCallIds.clear();
  }

  private remember(callId: string): void {
    if (this.seenCallIds.size >= this.maxCallIds) {
      const oldest = this.seenCallIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.seenCallIds.delete(oldest);
    }
    this.seenCallIds.add(callId);
  }
}

export interface PendingStateStoreOptions {
  /** Absolute XDG state root; defaults to XDG_STATE_HOME or ~/.local/state. */
  stateRoot?: string;
  /** Test seam for deterministic temporary names. */
  tempName?: () => string;
}

function defaultStateRoot(): string {
  return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function validateStateRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    !path.isAbsolute(value) ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw invalidState();
  }
  const normalized = path.normalize(value);
  if (normalized === path.parse(normalized).root) throw invalidState();
  return normalized;
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

function ownedByProcess(uid: bigint): boolean {
  const getter = process.getuid;
  return typeof getter !== "function" || uid === BigInt(getter());
}

async function directoryIdentity(
  directory: string,
  requirePrivate: boolean,
): Promise<DirectoryIdentity> {
  try {
    const state = await lstat(directory, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink()) throw invalidState();
    if (requirePrivate && (
      !ownedByProcess(state.uid) ||
      (state.mode & 0o077n) !== 0n
    )) throw invalidState();
    return { path: directory, dev: state.dev, ino: state.ino };
  } catch (error) {
    if (error instanceof CheckpointStateError) throw error;
    throw invalidState("io_error");
  }
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(expected.path, true);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw invalidState();
}

async function ensureStateBase(stateRoot: string): Promise<DirectoryIdentity> {
  const parsed = path.parse(stateRoot);
  let current = parsed.root;
  const segments = stateRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw invalidState("io_error");
    }
    await directoryIdentity(current, current === stateRoot);
  }
  return await directoryIdentity(stateRoot, true);
}

async function ensurePrivateChild(parent: DirectoryIdentity, name: string): Promise<DirectoryIdentity> {
  await assertDirectoryIdentity(parent);
  const child = path.join(parent.path, name);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw invalidState("io_error");
  }
  const identity = await directoryIdentity(child, true);
  await assertDirectoryIdentity(parent);
  return identity;
}

/** Ensure the fixed state subtree is private, owned, and never symlinked. */
async function ensurePendingDirectory(stateRoot: string): Promise<DirectoryIdentity> {
  const base = await ensureStateBase(stateRoot);
  const service = await ensurePrivateChild(base, "resyst-vault");
  return await ensurePrivateChild(service, "pending");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    throw invalidState("io_error");
  } finally {
    try {
      await handle?.close();
    } catch {
      throw invalidState("io_error");
    }
  }
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

async function readBoundedUtf8(handle: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(MAX_CHECKPOINT_STATE_RECORD_BYTES + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      if (result.bytesRead < 0) throw invalidState("io_error");
      offset += result.bytesRead;
    }
  } catch (error) {
    if (error instanceof CheckpointStateError) throw error;
    throw invalidState("io_error");
  }
  if (offset > MAX_CHECKPOINT_STATE_RECORD_BYTES) {
    throw invalidState("record_too_large");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
  } catch {
    throw invalidState("utf8_invalid");
  }
}

const O_RDONLY = fsConstants.O_RDONLY;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Machine-local source-of-truth store.  The filename is a SHA-256 digest of
 * the session id; the session id itself is never present in a path.
 */
export class PendingStateStore {
  readonly stateRoot: string;
  readonly pendingRoot: string;
  private readonly tempName: (() => string) | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly volatilePending = new Map<string, CheckpointStateRecord>();

  constructor(options: PendingStateStoreOptions = {}) {
    this.stateRoot = validateStateRoot(options.stateRoot ?? defaultStateRoot());
    this.pendingRoot = path.join(this.stateRoot, "resyst-vault", "pending");
    this.tempName = options.tempName;
  }

  pathFor(sessionId: string): string {
    if (!boundedSessionId(sessionId)) throw invalidState();
    return path.join(this.pendingRoot, `${hashSessionId(sessionId)}.json`);
  }

  /** Latest runtime state, including a conservative fallback after disk failure. */
  async current(sessionId: string): Promise<CheckpointStateRecord | null> {
    if (!boundedSessionId(sessionId)) throw invalidState();
    const volatile = this.volatilePending.get(sessionId);
    if (volatile !== undefined) return cloneStateRecord(volatile);
    return await this.load(sessionId);
  }

  hasVolatilePending(sessionId: string): boolean {
    return boundedSessionId(sessionId) && this.volatilePending.has(sessionId);
  }

  /** Serialize the complete cross-process load/reduce/save mutation. */
  async update(
    sessionId: string,
    reducer: (current: CheckpointStateRecord | null) => CheckpointStateRecord,
  ): Promise<CheckpointStateRecord> {
    if (!boundedSessionId(sessionId) || typeof reducer !== "function") throw invalidState();
    const operation = this.mutationTail.then(async () => {
      await ensurePendingDirectory(this.stateRoot);
      const lock = new LocalLock({
        stateRoot: this.stateRoot,
        name: `checkpoint-${hashSessionId(sessionId)}.lock`,
      });
      let held: LockHandle | undefined;
      try { held = await lock.acquire(); }
      catch {
        const current = await this.current(sessionId);
        const next = parseCheckpointStateRecord(reducer(current));
        if (next.session_id === sessionId) this.volatilePending.set(sessionId, cloneStateRecord(next));
        throw invalidState("io_error");
      }
      let next: CheckpointStateRecord;
      try {
        const current = await this.current(sessionId);
        next = parseCheckpointStateRecord(reducer(current));
        if (next.session_id !== sessionId) throw invalidState();
        try {
          await this.save(next);
          this.volatilePending.delete(sessionId);
        } catch {
          this.volatilePending.set(sessionId, cloneStateRecord(next));
          throw invalidState("io_error");
        }
      } finally {
        try { await held.release(); }
        catch { throw invalidState("io_error"); }
      }
      return next;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async save(record: CheckpointStateRecord): Promise<void> {
    const canonical = parseCheckpointStateRecord(record);
    let serialized: string;
    try {
      serialized = JSON.stringify(canonical);
    } catch {
      throw invalidState();
    }
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_STATE_RECORD_BYTES
    ) {
      throw invalidState("record_too_large");
    }

    const directory = await ensurePendingDirectory(this.stateRoot);
    const destination = this.pathFor(canonical.session_id);
    let suffix: string;
    try {
      suffix = this.tempName?.() ?? randomBytes(16).toString("hex");
    } catch {
      throw invalidState("io_error");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(suffix)) throw invalidState();
    const temporary = path.join(
      directory.path,
      `.${path.basename(destination)}.tmp-${process.pid}-${suffix}`,
    );
    let handle: FileHandle | undefined;
    let ownsTemporary = false;
    try {
      await assertDirectoryIdentity(directory);
      handle = await open(temporary, "wx", 0o600);
      ownsTemporary = true;
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertDirectoryIdentity(directory);
      await rename(temporary, destination);
      ownsTemporary = false;
      await assertDirectoryIdentity(directory);
      await syncDirectory(directory.path);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // The public error remains fixed even when cleanup also fails.
      }
      if (ownsTemporary) {
        try {
          await unlink(temporary);
        } catch {
          // Best-effort cleanup; never expose the temporary path.
        }
      }
      if (error instanceof CheckpointStateError) throw error;
      throw invalidState("io_error");
    }
  }

  async load(sessionId: string): Promise<CheckpointStateRecord | null> {
    if (!boundedSessionId(sessionId)) throw invalidState();
    const file = this.pathFor(sessionId);
    const directory = await ensurePendingDirectory(this.stateRoot);
    let linkState: Awaited<ReturnType<typeof lstat>>;
    try {
      linkState = await lstat(file, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw invalidState("io_error");
    }
    if (
      !linkState.isFile() ||
      linkState.isSymbolicLink() ||
      (linkState.mode & 0o777n) !== 0o600n
    ) {
      throw invalidState();
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(file, O_RDONLY | O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.isSymbolicLink() ||
        opened.dev !== linkState.dev ||
        opened.ino !== linkState.ino ||
        (opened.mode & 0o777n) !== 0o600n ||
        opened.size < 0n ||
        opened.size > BigInt(MAX_CHECKPOINT_STATE_RECORD_BYTES)
      ) {
        throw invalidState();
      }
      const raw = await readBoundedUtf8(handle);
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        throw invalidState();
      }
      const record = parseCheckpointStateRecord(value);
      if (record.session_id !== sessionId) throw invalidState();
      await assertDirectoryIdentity(directory);
      return record;
    } catch (error) {
      if (error instanceof CheckpointStateError) throw error;
      throw invalidState("io_error");
    } finally {
      try {
        await handle?.close();
      } catch {
        // A close failure is not allowed to leak a raw filesystem error.
      }
    }
  }
}

export interface ReconcileCheckpointStateInput {
  sessionId: string;
  local: CheckpointStateRecord | null;
  mirrors: readonly CheckpointStateRecord[];
  reset: boolean;
  now: string;
}

function cloneStateRecord(record: CheckpointStateRecord): CheckpointStateRecord {
  return {
    version: record.version,
    session_id: record.session_id,
    revision: record.revision,
    state: record.state,
    substantial: record.substantial,
    uncertainty: record.uncertainty,
    checkpoint_seen: record.checkpoint_seen,
    updated_at: record.updated_at,
  };
}

function mirrorIsPending(state: CheckpointState): boolean {
  return state === "substantial_pending" ||
    state === "evaluation_pending" ||
    state === "evaluating";
}

/**
 * Reconcile machine-local authority with transcript mirrors:
 * - reset/new/fork wins unconditionally;
 * - a valid local record always wins, including over newer mirrors;
 * - only valid same-session mirrors can reconstruct lost pending state;
 * - reconstruction downgrades every pending mirror to evaluation_pending.
 */
export function reconcileCheckpointState(
  input: ReconcileCheckpointStateInput,
): CheckpointStateRecord {
  if (!isPlainRecord(input)) throw invalidState();
  const session = observationProperty(input, "sessionId");
  const localValue = observationProperty(input, "local");
  const mirrorsValue = observationProperty(input, "mirrors");
  const reset = observationProperty(input, "reset");
  const now = observationProperty(input, "now");
  if (!boundedSessionId(session) || typeof reset !== "boolean" || !boundedTimestamp(now)) {
    throw invalidState();
  }
  if (reset) return initialCheckpointRecord(session, now);
  if (!safeArray(mirrorsValue) || mirrorsValue.length > MAX_CHECKPOINT_MIRRORS) {
    throw invalidState();
  }

  if (localValue !== null) {
    const local = parseCheckpointStateRecord(localValue);
    if (local.session_id !== session) throw invalidState();
    return cloneStateRecord(local);
  }

  const sameSessionMirrors: CheckpointStateRecord[] = [];
  for (const mirrorValue of mirrorsValue) {
    try {
      const mirror = parseCheckpointStateRecord(mirrorValue);
      if (mirror.session_id === session) sameSessionMirrors.push(mirror);
    } catch {
      // A malformed transcript entry is untrusted and cannot block recovery.
    }
  }
  sameSessionMirrors.sort((left, right) => {
    if (left.revision !== right.revision) return right.revision - left.revision;
    const leftPending = mirrorIsPending(left.state) ? 1 : 0;
    const rightPending = mirrorIsPending(right.state) ? 1 : 0;
    if (leftPending !== rightPending) return rightPending - leftPending;
    return right.updated_at.localeCompare(left.updated_at);
  });
  const newest = sameSessionMirrors[0];
  if (newest !== undefined && mirrorIsPending(newest.state)) {
    return canonicalRecord(session, 1, "evaluation_pending", now);
  }
  return initialCheckpointRecord(session, now);
}
