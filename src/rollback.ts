/** Fail-closed, all-target rollback of an applied event. */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { JournalStore } from "./journal.js";
import type { LocalLock, LockHandle } from "./lock.js";
import { EventIdSchema, HashHexSchema, IdempotencyKeySchema, IsoTimestampSchema, parseWithSchema } from "./schemas.js";
import type { VaultPaths, VaultRootIdentity } from "./paths.js";
import type { EventId, HashHex, IdempotencyKey, Receipt, RolledBackReceipt, RollbackTarget, VaultPath } from "./types.js";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_RDONLY = fsConstants.O_RDONLY;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const O_WRONLY = fsConstants.O_WRONLY;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean { return errorCode(error) === "ENOENT"; }

async function directorySync(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP") throw new RollbackIntegrityError("invalid_state");
  } finally { await handle?.close().catch(() => undefined); }
}

export interface RollbackServiceOptions {
  vaultRoot: string;
  stateRoot: string;
  identity: VaultRootIdentity;
  paths: VaultPaths;
  journal: JournalStore;
  lock: LocalLock;
  now?: () => string;
  /** Test-only crash seam: fires after each target is restored or unlinked. */
  afterTarget?: (target: VaultPath, index: number) => Promise<void>;
  /** Test-only crash seam: fires after all targets are mutated, before the receipt is written. */
  beforeReceipt?: () => Promise<void>;
}
export type RollbackOutcome =
  | { kind: "rolled_back"; event_id: EventId; receipt: RolledBackReceipt }
  | { kind: "already_rolled_back"; event_id: EventId; receipt: RolledBackReceipt }
  | { kind: "rejected"; reason: "not_applied" | "precondition_mismatch" | "missing_backup" | "invalid_state"; mismatch_paths?: VaultPath[] };
interface Request { target_event_id: EventId; event_id: EventId; idempotency_key: IdempotencyKey; }
interface Backup { version: 1; event_id: EventId; path: VaultPath; existed: boolean; mode: number; before_hash: HashHex | null; backup_file: string | null; }
interface FileSnapshot { exists: boolean; hash: HashHex | null; dev: bigint | null; ino: bigint | null; }
function hash(value: string): HashHex { return createHash("sha256").update(value, "utf8").digest("hex") as HashHex; }
function request(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RollbackIntegrityError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["target_event_id", "event_id", "idempotency_key"].includes(key))) throw new RollbackIntegrityError();
  try { return { target_event_id: parseWithSchema(EventIdSchema, record.target_event_id, "target event"), event_id: parseWithSchema(EventIdSchema, record.event_id, "rollback event"), idempotency_key: parseWithSchema(IdempotencyKeySchema, record.idempotency_key, "rollback key") }; }
  catch { throw new RollbackIntegrityError(); }
}
function encoded(value: VaultPath): string { return Buffer.from(value, "utf8").toString("base64url"); }
function parseBackup(value: unknown, event: EventId, target: VaultPath): Backup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RollbackIntegrityError();
  const record = value as Record<string, unknown>;
  const keys = ["version", "event_id", "path", "existed", "mode", "before_hash", "backup_file"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record)) || record.version !== 1 || record.event_id !== event || record.path !== target || typeof record.existed !== "boolean" || !Number.isInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o7777 || (record.backup_file !== null && typeof record.backup_file !== "string")) throw new RollbackIntegrityError();
  let before: HashHex | null;
  try { before = record.before_hash === null ? null : parseWithSchema(HashHexSchema, record.before_hash, "backup hash"); } catch { throw new RollbackIntegrityError(); }
  return { version: 1, event_id: event, path: target, existed: record.existed, mode: record.mode as number, before_hash: before, backup_file: record.backup_file as string | null };
}
export class RollbackIntegrityError extends Error {
  readonly cause: "missing_backup" | "invalid_state" | "io_error";
  constructor(cause: "missing_backup" | "invalid_state" | "io_error" = "invalid_state") {
    super("rollback integrity check failed; details redacted");
    this.name = "RollbackIntegrityError";
    this.cause = cause;
  }
}

export class RollbackService {
  private readonly stateRoot: string;
  private readonly paths: VaultPaths;
  private readonly journal: JournalStore;
  private readonly lock: LocalLock;
  private readonly now: () => string;
  private readonly afterTarget?: (target: VaultPath, index: number) => Promise<void>;
  private readonly beforeReceipt?: () => Promise<void>;
  constructor(options: RollbackServiceOptions) {
    this.stateRoot = path.resolve(options.stateRoot);
    this.paths = options.paths;
    this.journal = options.journal;
    this.lock = options.lock;
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.afterTarget !== undefined) this.afterTarget = options.afterTarget;
    if (options.beforeReceipt !== undefined) this.beforeReceipt = options.beforeReceipt;
    void options.vaultRoot;
    void options.identity;
  }
  private async snapshot(absolute: string): Promise<FileSnapshot> {
    let linkStat;
    try { linkStat = await lstat(absolute, { bigint: true }); }
    catch (error) { if (isMissing(error)) return { exists: false, hash: null, dev: null, ino: null }; throw new RollbackIntegrityError("invalid_state"); }
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new RollbackIntegrityError("invalid_state");
    let handle: FileHandle | undefined;
    try {
      handle = await open(absolute, O_RDONLY | O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino || opened.size > BigInt(MAX_BACKUP_BYTES)) throw new RollbackIntegrityError("invalid_state");
      const content = await handle.readFile("utf8");
      return { exists: true, hash: hash(content), dev: opened.dev, ino: opened.ino };
    } catch (error) { if (error instanceof RollbackIntegrityError) throw error; throw new RollbackIntegrityError("invalid_state"); }
    finally { await handle?.close().catch(() => undefined); }
  }
  private async backupDirectory(event: EventId): Promise<string> {
    const root = path.resolve(this.stateRoot);
    const directory = path.join(root, "resyst-vault", "backups", event);
    let current = root;
    for (const candidate of [current, "resyst-vault", "backups", String(event)].map((part, index) => {
      if (index === 0) return part;
      current = path.join(current, part);
      return current;
    })) {
      let state;
      try { state = await lstat(candidate, { bigint: true }); } catch (error) { throw new RollbackIntegrityError(isMissing(error) ? "missing_backup" : "invalid_state"); }
      if (!state.isDirectory() || state.isSymbolicLink()) throw new RollbackIntegrityError("invalid_state");
    }
    return directory;
  }
  private async readBackupFile(file: string): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, O_RDONLY | O_NOFOLLOW);
      const state = await handle.stat({ bigint: true });
      if (!state.isFile() || state.size > BigInt(MAX_BACKUP_BYTES)) throw new RollbackIntegrityError("invalid_state");
      return await handle.readFile("utf8");
    } catch (error) {
      if (error instanceof RollbackIntegrityError) throw error;
      throw new RollbackIntegrityError(isMissing(error) ? "missing_backup" : "invalid_state");
    } finally { await handle?.close().catch(() => undefined); }
  }
  private async backup(event: EventId, target: VaultPath): Promise<{ record: Backup; content: string | null }> {
    const directory = await this.backupDirectory(event);
    const key = encoded(target);
    const raw = await this.readBackupFile(path.join(directory, `${key}.json`));
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new RollbackIntegrityError("invalid_state"); }
    const record = parseBackup(value, event, target);
    if (record.existed !== (record.before_hash !== null) || record.backup_file !== (record.existed ? `${key}.before` : null)) throw new RollbackIntegrityError("invalid_state");
    let content: string | null = null;
    if (record.backup_file !== null) {
      content = await this.readBackupFile(path.join(directory, record.backup_file));
      if (hash(content) !== record.before_hash) throw new RollbackIntegrityError("invalid_state");
    }
    return { record, content };
  }
  private async write(absolute: string, content: string, mode: number, expected: FileSnapshot): Promise<void> {
    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.rollback-${randomBytes(8).toString("hex")}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const current = await this.snapshot(absolute);
      if (current.exists !== expected.exists || current.hash !== expected.hash || current.dev !== expected.dev || current.ino !== expected.ino) throw new RollbackIntegrityError("invalid_state");
      await rename(temporary, absolute);
      await directorySync(path.dirname(absolute));
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new RollbackIntegrityError("io_error");
    }
  }
  async rollback(value: unknown): Promise<RollbackOutcome> {
    const input = request(value);
    const existing = await this.journal.findReceiptByIdempotency(input.idempotency_key);
    if (existing?.receipt.outcome === "rolled_back") return { kind: "already_rolled_back", event_id: existing.event_id, receipt: existing.receipt };
    let held: LockHandle;
    try { held = await this.lock.acquire(); } catch { return { kind: "rejected", reason: "invalid_state" }; }
    try {
      const lockedReceipt = await this.journal.findReceiptByIdempotency(input.idempotency_key);
      if (lockedReceipt !== null) {
        if (lockedReceipt.receipt.outcome === "rolled_back") return { kind: "already_rolled_back", event_id: lockedReceipt.event_id, receipt: lockedReceipt.receipt };
        return { kind: "rejected", reason: "invalid_state" };
      }
      let applied: Receipt;
      try { applied = await this.journal.readReceipt(input.target_event_id); }
      catch { return { kind: "rejected", reason: "not_applied" }; }
      if (applied.outcome !== "applied") return { kind: "rejected", reason: "not_applied" };
      const expectedTargets: RollbackTarget[] = [...applied.targets]
        .sort((left, right) => String(left.path).localeCompare(String(right.path)))
        .map((target) => ({ path: target.path, before_hash: target.after_hash, after_hash: target.before_hash }));
      const matchingEvents = (await this.journal.listEvents()).filter((event) => event.event_id === input.event_id);
      if (matchingEvents.length > 1) throw new RollbackIntegrityError("invalid_state");
      const priorEvent = matchingEvents[0];
      const recovery = priorEvent !== undefined;
      if (priorEvent !== undefined && (
        priorEvent.kind !== "rollback" ||
        priorEvent.idempotency_key !== input.idempotency_key ||
        priorEvent.target_event_id !== input.target_event_id ||
        JSON.stringify(priorEvent.rollback_targets) !== JSON.stringify(expectedTargets)
      )) throw new RollbackIntegrityError("invalid_state");
      // All-target lock + preflight: resolve every target, read every backup,
      // and check every current-vs-after hash before publishing the immutable
      // rollback intent.
      const resolved = await Promise.all(applied.targets.map(async (target) => ({ target, path: await this.paths.resolveWrite(target.path), backup: await this.backup(input.target_event_id, target.path) })));
      const mismatches: VaultPath[] = [];
      for (const item of resolved) {
        const current = (await this.snapshot(item.path.absolute)).hash;
        if (recovery) {
          // Recovery accepts the target's recorded before_hash (already
          // restored by a previous attempt) as a no-op frontier.
          if (current !== item.target.after_hash && current !== item.target.before_hash) mismatches.push(item.target.path);
        } else {
          if (current !== item.target.after_hash) mismatches.push(item.target.path);
        }
      }
      if (mismatches.length > 0) return { kind: "rejected", reason: "precondition_mismatch", mismatch_paths: mismatches.sort() };
      // Immutable intent FIRST: persist the rollback event before mutating
      // any target. A crash between the event write and the target restore
      // is recoverable by re-running rollback (idempotent: the event is
      // already durable; targets re-restore deterministically).
      const createdAt = priorEvent?.created_at ?? parseWithSchema(IsoTimestampSchema, this.now(), "rollback timestamp");
      const sortedItems = [...resolved].sort((left, right) => String(left.target.path).localeCompare(String(right.target.path)));
      const rollbackTargets = expectedTargets;
      if (!recovery) {
        await this.journal.writeEvent({ version: 1, kind: "rollback", event_id: input.event_id, idempotency_key: input.idempotency_key, created_at: createdAt, target_event_id: input.target_event_id, rollback_targets: rollbackTargets });
      }
      // Mutate each target in deterministic path order. The atomic write
      // helper fsyncs the parent directory after rename; the unlink path
      // fsyncs the parent directory directly so a created-file rollback is
      // durable across a process crash. In recovery mode, targets already at
      // the recorded before_hash are skipped (their durable frontier was
      // written by the previous attempt).
      for (let index = 0; index < sortedItems.length; index += 1) {
        const item = sortedItems[index]!;
        const current = await this.snapshot(item.path.absolute);
        if (recovery && current.hash === item.target.before_hash) continue;
        if (current.hash !== item.target.after_hash) throw new RollbackIntegrityError("invalid_state");
        if (item.backup.content === null) await this.unlinkCreated(item.path.absolute, current);
        else await this.write(item.path.absolute, item.backup.content, item.backup.record.mode, current);
        if (this.afterTarget !== undefined) await this.afterTarget(item.target.path, index);
      }
      // Final crash seam: a crash here leaves all targets restored but no
      // durable receipt; the next call sees the rollback event (recovery),
      // detects all targets at before_hash, skips mutations, and writes
      // the receipt.
      if (this.beforeReceipt !== undefined) await this.beforeReceipt();
      const receipt = await this.journal.writeReceipt({ version: 1, outcome: "rolled_back", event_id: input.event_id, idempotency_key: input.idempotency_key, target_event_id: input.target_event_id, rollback_targets: rollbackTargets, created_at: createdAt });
      if (receipt.outcome !== "rolled_back") throw new RollbackIntegrityError("invalid_state");
      return { kind: "rolled_back", event_id: input.event_id, receipt };
    } catch (error) {
      // The backup helper throws RollbackIntegrityError to redact I/O or
      // parse failures; map the explicit "backup file missing" cause to the
      // documented `missing_backup` outcome and every other corruption
      // (corrupt JSON, hash mismatch, stat failure) to `invalid_state`.
      if (error instanceof RollbackIntegrityError) {
        if (error.cause === "missing_backup") return { kind: "rejected", reason: "missing_backup" };
        return { kind: "rejected", reason: "invalid_state" };
      }
      throw error;
    }
    finally { await held.release(); }
  }

  private async unlinkCreated(absolute: string, expected: FileSnapshot): Promise<void> {
    const parent = path.dirname(absolute);
    const current = await this.snapshot(absolute);
    if (!current.exists || current.hash !== expected.hash || current.dev !== expected.dev || current.ino !== expected.ino) throw new RollbackIntegrityError("invalid_state");
    try { await unlink(absolute); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw new RollbackIntegrityError("io_error"); }
    await directorySync(parent);
  }
}
