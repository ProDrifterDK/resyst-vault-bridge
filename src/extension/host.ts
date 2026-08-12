/**
 * Prime Agent runtime authority boundary.
 *
 * Every persisted session header is treated as the only authoritative source
 * for whether a turn is a root or a child. Session names, directory naming
 * heuristics, or a spoofable model argument are never trusted.
 *
 * The bootstrap loop cache isolates one in-flight root turn: the first
 * successful nonempty leader resolves with the bootstrap context, every
 * concurrent follower awaits the leader and returns null, and empty/failed
 * loads leave the cache unchanged so a subsequent call can recover. The
 * cache stores only a completed marker (never the resolved context text)
 * so the resolved string is held by the leader promise alone and discarded
 * the moment the leader settles.
 */
import { createHash } from "node:crypto";

const MAX_SESSION_ID_LENGTH = 1024;
const MAX_PROMPT_LENGTH = 65_536;
const MAX_SAFE_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * Maximum number of distinct keys kept in the loop cache. Once exceeded, the
 * oldest key is evicted to make room for the new entry. The bound is small
 * and deterministic so the cache cannot be exhausted by an adversarial
 * caller supplying many distinct prompt fingerprints.
 */
export const MAX_CACHE_KEYS = 32;

/** Maximum number of concurrent in-flight loader promises. */
export const MAX_IN_FLIGHT_LOADS = 4;

/**
 * Authority derived from a persisted `SessionHeader`. Only a safe integer
 * `rlmDepth === 0` plus a bounded nonempty `id` ever marks the turn as root;
 * every other shape fails closed without trusting spoofable metadata.
 */
export interface SessionAuthority {
  session_id: string | null;
  depth: number | null;
  is_root: boolean;
}

/**
 * Read one own property of an `unknown` host boundary value through a
 * defensive getter. Returns `null` for non-objects, throwing getters, proxy
 * traps, non-string values, or values that exceed the conservative length
 * budget. Hostile proxies, revoked proxies, or values with overridden
 * `Object.keys` semantics are all coerced to `null` so the caller never has
 * to defend against secondary traps.
 */
export function safeReadStringProperty(
  source: unknown,
  key: string,
  maxLength: number,
): string | null {
  if (source === null || typeof source !== "object") return null;
  let value: unknown;
  try {
    value = (source as Record<string, unknown>)[key];
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxLength) return null;
  return value;
}

export function authorityFromHeader(header: unknown): SessionAuthority {
  const id = safeReadStringProperty(header, "id", MAX_SESSION_ID_LENGTH);
  if (id === null) {
    return { session_id: null, depth: null, is_root: false };
  }
  let depthValue: unknown;
  if (header !== null && typeof header === "object") {
    try {
      depthValue = (header as Record<string, unknown>).rlmDepth;
    } catch {
      depthValue = undefined;
    }
  }
  if (
    typeof depthValue !== "number" ||
    !Number.isInteger(depthValue) ||
    depthValue < 0 ||
    depthValue > MAX_SAFE_DEPTH
  ) {
    return { session_id: id, depth: null, is_root: false };
  }
  return {
    session_id: id,
    depth: depthValue,
    is_root: depthValue === 0,
  };
}

const WHITESPACE_PATTERN = /[\s\u2028\u2029]+/gu;

/**
 * Deterministic normalized SHA-256 fingerprint of a prompt string.
 *
 * The fingerprint never contains the prompt text; only the hex digest.
 * Normalization is NFC + collapse-all-whitespace + trim so cosmetic
 * differences (CR/LF, leading/trailing spaces, line separators) hash
 * identically. Non-string or oversized inputs collapse to a stable
 * "unsupported" fingerprint so the cache key never widens to fit caller
 * data.
 */
export function promptFingerprint(prompt: unknown): string {
  const safe = typeof prompt === "string" ? prompt : "";
  if (safe.length > MAX_PROMPT_LENGTH) {
    return createHash("sha256")
      .update("unsupported-prompt", "utf8")
      .digest("hex");
  }
  const normalized = safe
    .normalize("NFC")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

interface CachePending {
  status: "pending";
  token: symbol;
  promise: Promise<void>;
}

interface CacheCompleted {
  /** Marker only: the resolved context text is never stored on the entry. */
  status: "completed";
}

type CacheEntry = CachePending | CacheCompleted;

/**
 * Ephemeral bounded cache keyed by session + normalized prompt fingerprint.
 * Completed entries retain only a marker. Pending entries retain only a
 * settlement promise, while the leader owns the context value.
 */
export class BootstrapLoopCache {
  private readonly entries = new Map<string, CacheEntry>();
  private generation = 0;

  /**
   * Run the loader at most once for one key in the current agent loop.
   * Empty, failed, over-budget, and lifecycle-invalidated loads do not leave
   * a completed marker, so a later legitimate turn can retry.
   */
  load(
    session: unknown,
    prompt: unknown,
    loader: () => Promise<string>,
  ): Promise<string | null> {
    if (
      typeof session !== "string" ||
      session.length === 0 ||
      session.length > MAX_SESSION_ID_LENGTH
    ) {
      return Promise.resolve(null);
    }
    const key = `${session}\0${promptFingerprint(prompt)}`;
    const current = this.entries.get(key);
    if (current !== undefined) {
      if (current.status === "completed") return Promise.resolve(null);
      return current.promise.then(() => null);
    }
    if (this.pendingCount() >= MAX_IN_FLIGHT_LOADS || !this.makeRoom()) {
      return Promise.resolve(null);
    }

    const token = Symbol("bootstrap-load");
    const generation = this.generation;
    let leader: Promise<string>;
    try {
      leader = loader();
    } catch (error) {
      return Promise.reject(error);
    }
    const settled = leader.then(
      () => undefined,
      () => undefined,
    );
    this.entries.set(key, { status: "pending", token, promise: settled });

    return leader.then(
      (value: unknown) => {
        if (this.generation !== generation || !this.isCurrent(key, token)) {
          return null;
        }
        if (typeof value !== "string" || value.length === 0) {
          this.entries.delete(key);
          return null;
        }
        this.entries.set(key, { status: "completed" });
        return value;
      },
      (error: unknown) => {
        if (this.isCurrent(key, token)) this.entries.delete(key);
        throw error;
      },
    );
  }

  /** Invalidate completed and pending entries without retaining their text. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
  }

  /** Read-only size access for diagnostics and tests. */
  size(): number {
    return this.entries.size;
  }

  private isCurrent(key: string, token: symbol): boolean {
    const entry = this.entries.get(key);
    return entry?.status === "pending" && entry.token === token;
  }

  private pendingCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "pending") count += 1;
    }
    return count;
  }

  /** Evict the oldest completed marker; pending work is never orphaned. */
  private makeRoom(): boolean {
    if (this.entries.size < MAX_CACHE_KEYS) return true;
    for (const [key, entry] of this.entries) {
      if (entry.status === "completed") {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}
