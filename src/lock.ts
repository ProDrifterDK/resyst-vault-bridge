/** Machine-local PID + process-start identity lock. */
import { randomBytes } from "node:crypto";
import { open, mkdir, lstat, readFile, unlink, link } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export type OwnerLiveness = true | false | "unknown";

export interface LockOwner {
  version: 1;
  pid: number;
  process_start: string;
  acquired_at: string;
}

export interface LocalLockOptions {
  /** XDG state root; the lock is placed below resyst-vault/locks. */
  stateRoot?: string;
  /** Name of the owner record below the lock directory. */
  name?: string;
  /** Process identity; production defaults to the current process. */
  pid?: number;
  processStart?: string;
  /** Maximum time to wait for a live/unknown owner to leave. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  retryMs?: number;
  /** Injected clock for deterministic tests. */
  now?: () => string;
  /** Injected owner liveness probe. Unknown must fail closed. */
  isOwnerLive?: (owner: LockOwner) => OwnerLiveness | Promise<OwnerLiveness>;
  /** Monotonic-ish timeout clock seam; defaults to Date.now. */
  nowMs?: () => number;
  /** Waiting seam; defaults to setTimeout. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam to exercise compare-before-unlink races. */
  beforeAbandonedUnlink?: () => Promise<void>;
  /** Test-only temporary-name seam; production names always use randomBytes. */
  tempName?: () => string;
}

export interface LockHandle {
  readonly owner: LockOwner;
  readonly path: string;
  release(): Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor() {
    super("local write lock unavailable before timeout");
    this.name = "LockTimeoutError";
  }
}

export class LockIntegrityError extends Error {
  constructor() {
    super("local write lock state is invalid; details redacted");
    this.name = "LockIntegrityError";
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;
const MAX_OWNER_BYTES = 4_096;
const MAX_PROCESS_START_LENGTH = 256;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validProcessStart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROCESS_START_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAX_PROCESS_START_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function narrowOwner(value: unknown): LockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.pid !== "number" ||
    !safeInteger(record.pid) ||
    !validProcessStart(record.process_start) ||
    typeof record.acquired_at !== "string" ||
    !ISO_RE.test(record.acquired_at) ||
    !Number.isFinite(new Date(record.acquired_at).getTime()) ||
    Object.keys(record).some((key) => !["version", "pid", "process_start", "acquired_at"].includes(key))
  ) return null;
  return {
    version: 1,
    pid: record.pid,
    process_start: record.process_start,
    acquired_at: record.acquired_at,
  };
}

function defaultStateRoot(): string {
  return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

function parseProcStart(value: string): string | null {
  // /proc/<pid>/stat contains a comm field which may contain spaces and ')'.
  const close = value.lastIndexOf(")");
  if (close < 0) return null;
  const fields = value.slice(close + 1).trim().split(/\s+/u);
  // fields[0] is state (field 3); field 22 is index 19.
  const start = fields[19];
  return start !== undefined && /^\d+$/u.test(start) ? start : null;
}

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    return parseProcStart(content);
  } catch {
    return null;
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new LockIntegrityError();
  }
  const stat = await lstat(directory, { bigint: true }).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LockIntegrityError();
  }
}

async function ensureParentChain(root: string, directory: string): Promise<void> {
  const rootAbsolute = path.resolve(root);
  const directoryAbsolute = path.resolve(directory);
  if (directoryAbsolute !== rootAbsolute && !directoryAbsolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    throw new LockIntegrityError();
  }
  const relative = path.relative(rootAbsolute, directoryAbsolute);
  let current = rootAbsolute;
  await ensureDirectory(current);
  for (const segment of relative.split(path.sep).filter((item) => item.length > 0)) {
    current = path.join(current, segment);
    await ensureDirectory(current);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP") {
      throw new LockIntegrityError();
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.floor(value)
    : fallback;
}

function validRetry(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 60_000
    ? Math.floor(value)
    : DEFAULT_RETRY_MS;
}

/**
 * A local lock uses O_EXCL owner publication. Abandoned records are removed
 * only when the PID is proven gone or its process-start identity differs;
 * unknown liveness always remains blocked.
 */
export class LocalLock {
  readonly path: string;
  private readonly options: Required<Pick<LocalLockOptions, "timeoutMs" | "retryMs">> & LocalLockOptions;
  private readonly pid: number;
  private readonly processStart: string | undefined;
  private readonly stateRoot: string;
  private readonly nowMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly tempName: (() => string) | undefined;

  constructor(options: LocalLockOptions = {}) {
    this.stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot());
    const name = options.name ?? "write.lock";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw new LockIntegrityError();
    this.path = path.join(this.stateRoot, "resyst-vault", "locks", name);
    this.pid = options.pid ?? process.pid;
    this.processStart = options.processStart;
    this.options = {
      ...options,
      timeoutMs: validTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS),
      retryMs: validRetry(options.retryMs),
    };
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.tempName = options.tempName;
  }

  private async ownerForAcquire(): Promise<LockOwner> {
    const start = this.processStart === undefined
      ? await processStartIdentity(this.pid)
      : this.processStart;
    if (!safeInteger(this.pid) || !validProcessStart(start)) {
      throw new LockIntegrityError();
    }
    const now = this.options.now?.() ?? new Date().toISOString();
    if (!ISO_RE.test(now) || !Number.isFinite(new Date(now).getTime())) throw new LockIntegrityError();
    return { version: 1, pid: this.pid, process_start: start, acquired_at: now };
  }

  private async ownerLive(owner: LockOwner): Promise<OwnerLiveness> {
    if (this.options.isOwnerLive !== undefined) {
      try {
        const answer = await this.options.isOwnerLive(owner);
        return answer === true || answer === false || answer === "unknown" ? answer : "unknown";
      } catch {
        return "unknown";
      }
    }
    if (owner.pid === process.pid && this.processStart !== undefined && owner.process_start === this.processStart) {
      return true;
    }
    let processExists: boolean;
    try {
      process.kill(owner.pid, 0);
      processExists = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") return false;
      return "unknown";
    }
    if (!processExists) return false;
    const current = await processStartIdentity(owner.pid);
    if (current === null) return "unknown";
    return current === owner.process_start;
  }

  private async readOwner(): Promise<LockOwner | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "r", O_NOFOLLOW);
      const ownerStat = await handle.stat({ bigint: true });
      if (!ownerStat.isFile()) throw new LockIntegrityError();
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_OWNER_BYTES) throw new LockIntegrityError();
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; } catch { throw new LockIntegrityError(); }
      const owner = narrowOwner(parsed);
      if (owner === null) throw new LockIntegrityError();
      return owner;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (error instanceof LockIntegrityError) throw error;
      throw new LockIntegrityError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async tryRemoveAbandoned(owner: LockOwner): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "r", O_NOFOLLOW);
      const ownerStat = await handle.stat({ bigint: true });
      if (!ownerStat.isFile()) throw new LockIntegrityError();
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_OWNER_BYTES) throw new LockIntegrityError();
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; } catch { throw new LockIntegrityError(); }
      const current = narrowOwner(parsed);
      if (current === null || JSON.stringify(current) !== JSON.stringify(owner)) return;
      if (this.options.beforeAbandonedUnlink !== undefined) {
        await this.options.beforeAbandonedUnlink();
      }
      const pathStat = await lstat(this.path, { bigint: true });
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        pathStat.dev !== ownerStat.dev ||
        pathStat.ino !== ownerStat.ino
      ) return;
      await unlink(this.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (error instanceof LockIntegrityError) throw error;
      throw new LockIntegrityError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async tryCreate(owner: LockOwner): Promise<LockHandle | null | "temp_collision"> {
    const directory = path.dirname(this.path);
    await ensureParentChain(this.stateRoot, directory);
    let temporary: string;
    try {
      const suffix = this.tempName?.() ?? randomBytes(16).toString("hex");
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(suffix)) throw new LockIntegrityError();
      temporary = `${this.path}.tmp-${this.pid}-${suffix}`;
    } catch (error) {
      if (error instanceof LockIntegrityError) throw error;
      throw new LockIntegrityError();
    }
    let handle: FileHandle | undefined;
    let ownsTemporary = false;
    try {
      // A collision with another publisher's temporary name is not final-path
      // contention. Leave that file untouched and retry with a fresh name.
      try {
        handle = await open(temporary, "wx", 0o600);
        ownsTemporary = true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return "temp_collision";
        throw error;
      }
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Publish via a hard link, never by opening the final path and then
        // filling it: contenders must observe either no owner or a complete,
        // fsynced owner record.
        await link(temporary, this.path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          try { await unlink(temporary); }
          catch (cleanupError) {
            if (errorCode(cleanupError) !== "ENOENT") throw cleanupError;
          }
          ownsTemporary = false;
          return null;
        }
        throw error;
      }
      try { await unlink(temporary); }
      catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") throw cleanupError;
      }
      ownsTemporary = false;
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (ownsTemporary) {
        try { await unlink(temporary); }
        catch (cleanupError) {
          if (errorCode(cleanupError) !== "ENOENT") throw new LockIntegrityError();
        }
      }
      if (error instanceof LockIntegrityError) throw error;
      throw new LockIntegrityError();
    }
    let ownerHandle: FileHandle;
    try {
      ownerHandle = await open(this.path, "r", O_NOFOLLOW);
      const fdStat = await ownerHandle.stat({ bigint: true });
      if (!fdStat.isFile()) throw new LockIntegrityError();
    } catch (error) {
      throw error instanceof LockIntegrityError ? error : new LockIntegrityError();
    }
    let released = false;
    return {
      owner,
      path: this.path,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        let failure: unknown;
        try {
          const fdStat = await ownerHandle.stat({ bigint: true });
          const currentStat = await lstat(this.path, { bigint: true });
          if (
            !currentStat.isFile() ||
            currentStat.isSymbolicLink() ||
            currentStat.dev !== fdStat.dev ||
            currentStat.ino !== fdStat.ino
          ) throw new LockIntegrityError();
          const current = await this.readOwner();
          if (current === null || JSON.stringify(current) !== JSON.stringify(owner)) {
            throw new LockIntegrityError();
          }
          await unlink(this.path);
        } catch (error) {
          failure = error;
        }
        try { await ownerHandle.close(); }
        catch { if (failure === undefined) failure = new LockIntegrityError(); }
        if (failure instanceof LockIntegrityError) throw failure;
        if (failure !== undefined) throw new LockIntegrityError();
      },
    };
  }

  async acquire(): Promise<LockHandle> {
    const owner = await this.ownerForAcquire();
    const timeout = this.options.timeoutMs;
    const retry = this.options.retryMs;
    const startMs = this.nowMs();
    if (!Number.isFinite(startMs)) throw new LockIntegrityError();
    const deadline = startMs + timeout;
    if (!Number.isFinite(deadline)) throw new LockIntegrityError();
    while (true) {
      const acquired = await this.tryCreate(owner);
      if (acquired !== null && acquired !== "temp_collision") return acquired;

      // Both final-path contention and a temporary-name collision must yield
      // to the same bounded retry loop. In particular, a missing final owner
      // after a race is not permission to spin without checking the deadline.
      const currentMs = this.nowMs();
      if (!Number.isFinite(currentMs)) throw new LockIntegrityError();
      if (currentMs >= deadline) throw new LockTimeoutError();
      const existing = await this.readOwner();
      if (existing !== null) {
        const live = await this.ownerLive(existing);
        if (live === false) await this.tryRemoveAbandoned(existing);
      }
      const afterReadMs = this.nowMs();
      if (!Number.isFinite(afterReadMs)) throw new LockIntegrityError();
      if (afterReadMs >= deadline) throw new LockTimeoutError();
      try { await this.sleep(retry); }
      catch { throw new LockIntegrityError(); }
    }
  }
}
