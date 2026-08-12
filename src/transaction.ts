/** Single-target, journal-first transactional vault apply. */
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { JournalIntegrityError, JournalStore } from "./journal.js";
import { LocalLock, LockTimeoutError, type LockHandle } from "./lock.js";
import { VaultPaths, nodeVaultPathsFs, type VaultRootIdentity } from "./paths.js";
import {
  EventIdSchema,
  HashHexSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  parseCheckpoint,
  parseWithSchema,
  VaultPathSchema,
} from "./schemas.js";
import type { WritePlan } from "./render.js";
import type {
  ApplyCheckpoint,
  CheckpointOutcome,
  EventId,
  FailReason,
  HashHex,
  IdempotencyKey,
  Receipt,
  VaultPath,
} from "./types.js";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_RDONLY = fsConstants.O_RDONLY;
const O_WRONLY = fsConstants.O_WRONLY;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_PROGRESS_BYTES = 16 * 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export interface TransactionInput {
  checkpoint: ApplyCheckpoint;
  idempotency_key: IdempotencyKey;
  event_id: EventId;
  plans: [WritePlan];
  /** Test-only failure injection at the final pre-rename boundary or crash seam. */
  hooks?: { beforeRename?: () => Promise<void>; afterRename?: () => Promise<void> };
}

export interface TransactionServiceOptions {
  vaultRoot: string;
  /** XDG state root, not the final `resyst-vault` directory. */
  stateRoot?: string;
  journal?: JournalStore;
  lock?: LocalLock;
  paths?: VaultPaths;
  /** Config-validated root identity; never inferred from current filesystem. */
  identity?: VaultRootIdentity;
  config?: BridgeConfig;
  /** Validated vault-relative Inbox directory when config is not supplied. */
  inboxDir?: string;
  now?: () => string;
  beforeRename?: () => Promise<void>;
  afterRename?: () => Promise<void>;
}

export class TransactionScopeError extends Error {
  constructor() {
    super("single-target transaction required; details redacted");
    this.name = "TransactionScopeError";
  }
}

export class TransactionIntegrityError extends Error {
  constructor() {
    super("transaction integrity check failed; details redacted");
    this.name = "TransactionIntegrityError";
  }
}

/** Test seam for a process crash after durable bytes/progress but before receipt. */
export class TransactionCrashError extends Error {
  constructor() {
    super("transaction crash injected; receipt intentionally not written");
    this.name = "TransactionCrashError";
  }
}

class ProgressIntegrityError extends TransactionIntegrityError {
  constructor() {
    super();
    this.name = "ProgressIntegrityError";
  }
}

interface TargetSnapshot {
  exists: boolean;
  content: string;
  hash: HashHex | null;
  mode: number;
  dev: bigint | null;
  ino: bigint | null;
}

interface BackupRecord {
  version: 1;
  event_id: EventId;
  path: VaultPath;
  existed: boolean;
  mode: number;
  before_hash: HashHex | null;
  backup_file: string | null;
}

interface ProgressRecord {
  version: 1;
  event_id: EventId;
  path: VaultPath;
  before_hash: HashHex | null;
  after_hash: HashHex;
  state: "prepared" | "renamed";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean { return errorCode(error) === "ENOENT"; }

function hashContent(value: string): HashHex {
  return parseWithSchema(
    HashHexSchema,
    createHash("sha256").update(value, "utf8").digest("hex"),
    "content hash",
  );
}

function nowIso(now: () => string): ReturnType<typeof parseWithSchema<typeof IsoTimestampSchema>> {
  const value = now();
  if (!ISO_RE.test(value) || !Number.isFinite(new Date(value).getTime())) throw new TransactionIntegrityError();
  return parseWithSchema(IsoTimestampSchema, value, "transaction timestamp");
}

function safeRecordName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isSafeVaultDirectory(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." &&
    ![".resyst", ".git", ".stfolder"].includes(segment) &&
    !/[\u0000-\u001f\u007f]/u.test(segment),
  );
}

function safeRelativePath(value: unknown): VaultPath {
  try { return parseWithSchema(VaultPathSchema, value, "transaction target path"); }
  catch { throw new TransactionIntegrityError(); }
}

function safeEventId(value: unknown): EventId {
  try { return parseWithSchema(EventIdSchema, value, "transaction event id"); }
  catch { throw new TransactionIntegrityError(); }
}

function safeKey(value: unknown): IdempotencyKey {
  try { return parseWithSchema(IdempotencyKeySchema, value, "transaction idempotency key"); }
  catch { throw new TransactionIntegrityError(); }
}

function safePlan(value: unknown): WritePlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TransactionIntegrityError();
  const record = value as Record<string, unknown>;
  const pathValue = safeRelativePath(record.path);
  const before = record.before_hash === null ? null : parseWithSchema(HashHexSchema, record.before_hash, "transaction before hash");
  const after = parseWithSchema(HashHexSchema, record.after_hash, "transaction after hash");
  if (typeof record.after_content !== "string" || record.after_content.length > 1_000_000) throw new TransactionIntegrityError();
  if (hashContent(record.after_content) !== after) throw new TransactionIntegrityError();
  const reasons = ["daily_create", "daily_update", "project_update", "landscape_moc", "landscape_claude"];
  if (typeof record.reason !== "string" || !reasons.includes(record.reason)) throw new TransactionIntegrityError();
  return { path: pathValue, before_hash: before, after_content: record.after_content, after_hash: after, reason: record.reason as WritePlan["reason"] };
}

function narrowInput(value: unknown): TransactionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TransactionIntegrityError();
  const record = value as Record<string, unknown>;
  let checkpoint: ReturnType<typeof parseCheckpoint>;
  try { checkpoint = parseCheckpoint(record.checkpoint); } catch { throw new TransactionIntegrityError(); }
  if (checkpoint.kind !== "apply") throw new TransactionIntegrityError();
  if (!Array.isArray(record.plans) || record.plans.length !== 1) throw new TransactionScopeError();
  const plan = safePlan(record.plans[0]);
  const event_id = safeEventId(record.event_id);
  const idempotency_key = safeKey(record.idempotency_key);
  const hooksValue = record.hooks;
  let hooks: TransactionInput["hooks"];
  if (hooksValue !== undefined) {
    if (typeof hooksValue !== "object" || hooksValue === null || Array.isArray(hooksValue)) throw new TransactionIntegrityError();
    const hooksRecord = hooksValue as Record<string, unknown>;
    const beforeRename = hooksRecord.beforeRename;
    const afterRename = hooksRecord.afterRename;
    if (
      (beforeRename !== undefined && typeof beforeRename !== "function") ||
      (afterRename !== undefined && typeof afterRename !== "function")
    ) throw new TransactionIntegrityError();
    if (beforeRename !== undefined || afterRename !== undefined) {
      hooks = {
        ...(beforeRename === undefined ? {} : { beforeRename: beforeRename as () => Promise<void> }),
        ...(afterRename === undefined ? {} : { afterRename: afterRename as () => Promise<void> }),
      };
    }
  }
  const result: TransactionInput = { checkpoint, idempotency_key, event_id, plans: [plan] };
  if (hooks !== undefined) result.hooks = hooks;
  return result;
}

function defaultStateRoot(): string {
  return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

async function ensurePrivateDirectory(root: string, directory: string): Promise<void> {
  const rootAbsolute = path.resolve(root);
  const directoryAbsolute = path.resolve(directory);
  if (directoryAbsolute !== rootAbsolute && !directoryAbsolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    throw new TransactionIntegrityError();
  }
  let current = rootAbsolute;
  const relative = path.relative(rootAbsolute, directoryAbsolute);
  const segments = relative.split(path.sep).filter((item) => item.length > 0);
  const all = [current, ...segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  })];
  for (const candidate of all) {
    let directoryStat;
    try { directoryStat = await lstat(candidate, { bigint: true }); }
    catch (error) {
      if (!isMissing(error)) throw new TransactionIntegrityError();
      try { await mkdir(candidate, { mode: 0o700 }); }
      catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw new TransactionIntegrityError();
      }
      try { directoryStat = await lstat(candidate, { bigint: true }); }
      catch { throw new TransactionIntegrityError(); }
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TransactionIntegrityError();
    try { await chmod(candidate, 0o700); }
    catch { throw new TransactionIntegrityError(); }
  }
}

async function directorySync(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try { handle = await open(directory, O_RDONLY); await handle.sync(); }
  catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP") throw new TransactionIntegrityError();
  }
  finally { await handle?.close().catch(() => undefined); }
}

async function readSnapshot(absolute: string): Promise<TargetSnapshot> {
  let linkStat;
  try { linkStat = await lstat(absolute, { bigint: true }); }
  catch (error) {
    if (isMissing(error)) return { exists: false, content: "", hash: null, mode: 0o600, dev: null, ino: null };
    throw new TransactionIntegrityError();
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new TransactionIntegrityError();
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== linkStat.dev || opened.ino !== linkStat.ino || !opened.isFile()) throw new TransactionIntegrityError();
    const content = await handle.readFile("utf8");
    return {
      exists: true,
      content,
      hash: hashContent(content),
      mode: Number(opened.mode & 0o7777n),
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    if (error instanceof TransactionIntegrityError) throw error;
    throw new TransactionIntegrityError();
  } finally { await handle?.close().catch(() => undefined); }
}

async function backupSnapshot(
  stateRoot: string,
  directory: string,
  eventId: EventId,
  relative: VaultPath,
  snapshot: TargetSnapshot,
): Promise<BackupRecord> {
  const backupDirectory = path.join(directory, String(eventId));
  await ensurePrivateDirectory(stateRoot, backupDirectory);
  const encoded = Buffer.from(relative, "utf8").toString("base64url");
  if (!safeRecordName(encoded)) throw new TransactionIntegrityError();
  const backupFile = snapshot.exists ? path.join(backupDirectory, `${encoded}.before`) : null;
  if (backupFile !== null) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(backupFile, O_WRONLY | O_CREAT | O_EXCL, 0o600);
      await handle.writeFile(snapshot.content, "utf8");
      await handle.sync();
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new TransactionIntegrityError();
      let existing: string;
      try { existing = await readFile(backupFile, "utf8"); }
      catch { throw new TransactionIntegrityError(); }
      if (existing !== snapshot.content) throw new TransactionIntegrityError();
    } finally { await handle?.close().catch(() => undefined); }
  }
  const metadataPath = path.join(backupDirectory, `${encoded}.json`);
  const metadata: BackupRecord = {
    version: 1,
    event_id: eventId,
    path: relative,
    existed: snapshot.exists,
    mode: snapshot.mode,
    before_hash: snapshot.hash,
    backup_file: backupFile === null ? null : path.basename(backupFile),
  };
  let metadataHandle: FileHandle | undefined;
  try {
    metadataHandle = await open(metadataPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    await metadataHandle.writeFile(JSON.stringify(metadata), "utf8");
    await metadataHandle.sync();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw new TransactionIntegrityError();
    let existing: string;
    try { existing = await readFile(metadataPath, "utf8"); }
    catch { throw new TransactionIntegrityError(); }
    if (existing !== JSON.stringify(metadata)) throw new TransactionIntegrityError();
  } finally { await metadataHandle?.close().catch(() => undefined); }
  await directorySync(backupDirectory);
  return metadata;
}

async function writeProgress(stateRoot: string, directory: string, record: ProgressRecord): Promise<void> {
  await ensurePrivateDirectory(stateRoot, directory);
  const destination = path.join(directory, "progress.json");
  const temporary = path.join(directory, `.progress.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  const contents = JSON.stringify(record);
  if (Buffer.byteLength(contents, "utf8") > MAX_PROGRESS_BYTES) throw new TransactionIntegrityError();
  let handle: FileHandle | undefined;
  let ownsTemporary = false;
  try {
    handle = await open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    ownsTemporary = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    ownsTemporary = false;
    await directorySync(directory);
  } catch {
    await handle?.close().catch(() => undefined);
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
    throw new TransactionIntegrityError();
  }
}

function parseProgressRecord(value: unknown, eventId: EventId, target: VaultPath): ProgressRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TransactionIntegrityError();
  const record = value as Record<string, unknown>;
  const keys = ["version", "event_id", "path", "before_hash", "after_hash", "state"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) {
    throw new TransactionIntegrityError();
  }
  if (record.version !== 1 || record.event_id !== eventId || record.path !== target) {
    throw new TransactionIntegrityError();
  }
  let beforeHash: HashHex | null;
  let afterHash: HashHex;
  try {
    beforeHash = record.before_hash === null
      ? null
      : parseWithSchema(HashHexSchema, record.before_hash, "progress before hash");
    afterHash = parseWithSchema(HashHexSchema, record.after_hash, "progress after hash");
  } catch {
    throw new TransactionIntegrityError();
  }
  if (record.state !== "prepared" && record.state !== "renamed") throw new TransactionIntegrityError();
  const parsedEvent = safeEventId(record.event_id);
  const parsedPath = safeRelativePath(record.path);
  if (parsedEvent !== eventId || parsedPath !== target) throw new TransactionIntegrityError();
  return {
    version: 1,
    event_id: parsedEvent,
    path: parsedPath,
    before_hash: beforeHash,
    after_hash: afterHash,
    state: record.state,
  };
}

async function existingPrivateDirectory(root: string, directory: string): Promise<boolean> {
  const rootAbsolute = path.resolve(root);
  const directoryAbsolute = path.resolve(directory);
  if (directoryAbsolute !== rootAbsolute && !directoryAbsolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    throw new TransactionIntegrityError();
  }
  const relative = path.relative(rootAbsolute, directoryAbsolute);
  const segments = relative.split(path.sep).filter((item) => item.length > 0);
  let current = rootAbsolute;
  for (const candidate of [current, ...segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  })]) {
    let directoryStat;
    try { directoryStat = await lstat(candidate, { bigint: true }); }
    catch (error) {
      if (isMissing(error)) return false;
      throw new TransactionIntegrityError();
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TransactionIntegrityError();
  }
  return true;
}

async function readProgress(
  stateRoot: string,
  directory: string,
  eventId: EventId,
  target: VaultPath,
): Promise<ProgressRecord | null> {
  if (!(await existingPrivateDirectory(stateRoot, directory))) return null;
  const progressPath = path.join(directory, "progress.json");
  let progressStat;
  try { progressStat = await lstat(progressPath, { bigint: true }); }
  catch (error) {
    if (isMissing(error)) return null;
    throw new ProgressIntegrityError();
  }
  if (!progressStat.isFile() || progressStat.isSymbolicLink()) throw new ProgressIntegrityError();
  let raw: string;
  try { raw = await readFile(progressPath, "utf8"); }
  catch { throw new ProgressIntegrityError(); }
  if (Buffer.byteLength(raw, "utf8") > MAX_PROGRESS_BYTES) throw new ProgressIntegrityError();
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new ProgressIntegrityError(); }
  try { return parseProgressRecord(parsed, eventId, target); }
  catch { throw new ProgressIntegrityError(); }
}

async function hasConflictCopy(parent: string, basename: string): Promise<boolean> {
  let entries: string[];
  try { entries = await readdir(parent); } catch { throw new TransactionIntegrityError(); }
  const extension = path.extname(basename);
  const stem = extension.length > 0 ? basename.slice(0, -extension.length) : basename;
  return entries.some((name) =>
    name.startsWith(`${stem}.sync-conflict-`) &&
    (extension.length === 0 || name.endsWith(extension)),
  );
}

function proposalData(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replaceAll("<", "&lt;")
    .replace(/[\\`*_\[\]|]/gu, "\\$&");
}

function proposalText(input: TransactionInput, target: VaultPath): string {
  const lines = [
    "# Resyst Vault Bridge — pending association",
    "",
    `event: ${proposalData(input.event_id)}`,
    `target: ${proposalData(target)}`,
    "",
    "## Proposed facts",
  ];
  for (const collection of Object.values(input.checkpoint.knowledge)) {
    for (const item of collection) lines.push(`- ${proposalData(item.text)}`);
  }
  lines.push("", "## Evidence");
  for (const collection of Object.values(input.checkpoint.evidence)) {
    for (const item of collection) lines.push(`- ${proposalData(item.id)}: ${proposalData(item.value)}`);
  }
  const result = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(result, "utf8") > MAX_PROPOSAL_BYTES) throw new TransactionIntegrityError();
  return result;
}

export class TransactionService {
  readonly vaultRoot: string;
  readonly stateRoot: string;
  readonly backupRoot: string;
  private readonly journal: JournalStore;
  private readonly lock: LocalLock;
  private readonly pathsPromise: Promise<VaultPaths>;
  private readonly inboxDir: string;
  private readonly now: () => string;
  private readonly beforeRename?: () => Promise<void>;
  private readonly afterRename?: () => Promise<void>;

  constructor(options: TransactionServiceOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot());
    this.backupRoot = path.join(this.stateRoot, "resyst-vault", "backups");
    const trustedIdentity = options.config?.vault_identity ?? options.identity;
    if (options.journal === undefined && trustedIdentity === undefined) throw new TransactionIntegrityError();
    this.journal = options.journal ?? (options.now === undefined
      ? new JournalStore({ vaultRoot: this.vaultRoot, identity: trustedIdentity! })
      : new JournalStore({ vaultRoot: this.vaultRoot, identity: trustedIdentity!, now: options.now }));
    this.lock = options.lock ?? new LocalLock({ stateRoot: this.stateRoot });
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.beforeRename !== undefined) this.beforeRename = options.beforeRename;
    if (options.afterRename !== undefined) this.afterRename = options.afterRename;
    const trustedPaths = options.paths ?? (
      options.config !== undefined
        ? new VaultPaths(this.vaultRoot, {
            identity: options.config.vault_identity,
            attachmentsDir: options.config.layout.attachments_dir,
          })
        : options.identity !== undefined
          ? new VaultPaths(this.vaultRoot, { identity: options.identity, fs: nodeVaultPathsFs })
          : null
    );
    if (trustedPaths === null) throw new TransactionIntegrityError();
    this.pathsPromise = Promise.resolve(trustedPaths);
    const inboxDir = options.config?.layout.inbox_dir ?? options.inboxDir;
    if (inboxDir === undefined || !isSafeVaultDirectory(inboxDir)) throw new TransactionIntegrityError();
    this.inboxDir = inboxDir;
  }

  private async writeConflictProposal(input: TransactionInput, target: VaultPath): Promise<VaultPath> {
    const proposalPath = safeRelativePath(`${this.inboxDir}/resyst-proposal-${input.event_id}.md`);
    const paths = await this.pathsPromise;
    const resolved = await paths.resolveWrite(proposalPath);
    const content = proposalText(input, target);
    const snapshot = await readSnapshot(resolved.absolute);
    if (snapshot.exists) {
      if (snapshot.content !== content) throw new TransactionIntegrityError();
      return proposalPath;
    }
    await this.writeAtomic(resolved.absolute, content, 0o600, snapshot, undefined);
    return proposalPath;
  }

  private async writeAtomic(
    absolute: string,
    content: string,
    mode: number,
    expected: TargetSnapshot | undefined,
    hook: (() => Promise<void>) | undefined,
  ): Promise<void> {
    const parent = path.dirname(absolute);
    let current: TargetSnapshot;
    try { current = await readSnapshot(absolute); }
    catch { throw new TransactionIntegrityError(); }
    if (expected !== undefined) {
      if (current.exists !== expected.exists || current.hash !== expected.hash || (current.exists && (current.dev !== expected.dev || current.ino !== expected.ino))) {
        throw new TransactionIntegrityError();
      }
    }
    const temporary = path.join(parent, `.${path.basename(absolute)}.resyst-${process.pid}-${randomBytes(8).toString("hex")}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
      await handle.writeFile(content, "utf8");
      await handle.chmod(mode & 0o7777);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (hook !== undefined) await hook();
      // Revalidate immediately before rename to close the target swap window.
      const finalCheck = await readSnapshot(absolute);
      if (expected !== undefined && (finalCheck.exists !== expected.exists || finalCheck.hash !== expected.hash || (finalCheck.exists && (finalCheck.dev !== expected.dev || finalCheck.ino !== expected.ino)))) {
        throw new TransactionIntegrityError();
      }
      await rename(temporary, absolute);
      await directorySync(parent);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof TransactionIntegrityError) throw error;
      throw new TransactionIntegrityError();
    }
  }

  private async outcomeFailed(input: TransactionInput, reason: FailReason, target: WritePlan): Promise<CheckpointOutcome> {
    const receipt: Receipt = await this.journal.writeReceipt({
      version: 1, outcome: "failed", event_id: input.event_id, idempotency_key: input.idempotency_key,
      reason, targets: [{ path: target.path, before_hash: target.before_hash, after_hash: target.after_hash }], created_at: nowIso(this.now),
    });
    if (receipt.outcome !== "failed") throw new TransactionIntegrityError();
    return { kind: "failed", event_id: input.event_id, receipt };
  }

  private outcomeFromReceipt(
    existing: { event_id: EventId; receipt: Receipt },
    idempotencyKey: IdempotencyKey,
  ): CheckpointOutcome {
    switch (existing.receipt.outcome) {
      case "applied":
        return {
          kind: "already_applied",
          idempotency_key: idempotencyKey,
          original_event_id: existing.event_id,
          original_receipt: existing.receipt,
        };
      case "deferred_conflict":
        return { kind: "deferred_conflict", event_id: existing.event_id, receipt: existing.receipt };
      case "failed":
        return { kind: "failed", event_id: existing.event_id, receipt: existing.receipt };
      default:
        // A receipt for a different transaction kind under this apply key is
        // an integrity conflict, never a reason to construct another event.
        throw new TransactionIntegrityError();
    }
  }

  private async outcomeApplied(input: TransactionInput, target: WritePlan): Promise<CheckpointOutcome> {
    const receipt: Receipt = await this.journal.writeReceipt({
      version: 1,
      outcome: "applied",
      event_id: input.event_id,
      idempotency_key: input.idempotency_key,
      targets: [{ path: target.path, before_hash: target.before_hash, after_hash: target.after_hash }],
      created_at: nowIso(this.now),
    });
    if (receipt.outcome !== "applied") throw new TransactionIntegrityError();
    return { kind: "applied", event_id: input.event_id, receipt };
  }

  private async applyLocked(input: TransactionInput, target: WritePlan): Promise<CheckpointOutcome> {
    const paths = await this.pathsPromise;
    let resolved;
    try { resolved = await paths.resolveWrite(target.path); }
    catch { return this.deferConflict(input, target.path); }

    const progressDirectory = path.join(this.backupRoot, String(input.event_id));
    let progress: ProgressRecord | null;
    try { progress = await readProgress(this.stateRoot, progressDirectory, input.event_id, target.path); }
    catch (error) {
      if (error instanceof ProgressIntegrityError) throw error;
      return this.outcomeFailed(input, "invalid_state", target);
    }
    if (progress?.state === "renamed") {
      const current = await readSnapshot(resolved.absolute);
      if (progress.before_hash !== target.before_hash || progress.after_hash !== target.after_hash) {
        throw new TransactionIntegrityError();
      }
      if (current.exists && current.hash === progress.after_hash) {
        // Durable renamed progress plus an exact after-hash is a completed
        // write whose receipt was lost; never reinterpret it as a conflict.
        return this.outcomeApplied(input, target);
      }
    }

    if (await hasConflictCopy(path.dirname(resolved.absolute), path.basename(resolved.absolute))) {
      return this.deferConflict(input, target.path);
    }
    let before: TargetSnapshot;
    try { before = await readSnapshot(resolved.absolute); }
    catch { return this.deferConflict(input, target.path); }
    if (before.exists !== (target.before_hash !== null) || before.hash !== target.before_hash) {
      return this.deferConflict(input, target.path);
    }
    try { await backupSnapshot(this.stateRoot, this.backupRoot, input.event_id, target.path, before); }
    catch { return this.outcomeFailed(input, "io_error", target); }

    try {
      await writeProgress(this.stateRoot, progressDirectory, {
        version: 1,
        event_id: input.event_id,
        path: target.path,
        before_hash: target.before_hash,
        after_hash: target.after_hash,
        state: "prepared",
      });
      const beforeRename = input.hooks?.beforeRename ?? this.beforeRename;
      await this.writeAtomic(resolved.absolute, target.after_content, before.mode, before, beforeRename);
      await writeProgress(this.stateRoot, progressDirectory, {
        version: 1,
        event_id: input.event_id,
        path: target.path,
        before_hash: target.before_hash,
        after_hash: target.after_hash,
        state: "renamed",
      });
      const afterRename = input.hooks?.afterRename ?? this.afterRename;
      if (afterRename !== undefined) await afterRename();
    } catch (error) {
      // This typed seam models process death: no failed receipt is truthful
      // after durable rename/progress, and the next invocation must recover.
      if (error instanceof TransactionCrashError) throw error;
      return this.outcomeFailed(input, "io_error", target);
    }
    return this.outcomeApplied(input, target);
  }

  async apply(value: unknown): Promise<CheckpointOutcome> {
    const input = narrowInput(value);
    const existing = await this.journal.findReceiptByIdempotency(input.idempotency_key);
    if (existing !== null) return this.outcomeFromReceipt(existing, input.idempotency_key);

    const priorEvent = await this.journal.findEventByIdempotency(input.idempotency_key);
    if (priorEvent !== null && priorEvent.kind !== "apply") {
      throw new TransactionIntegrityError();
    }
    const effectiveEventId = priorEvent?.event_id ?? input.event_id;
    const effectiveInput: TransactionInput = effectiveEventId === input.event_id
      ? input
      : { ...input, event_id: effectiveEventId };
    const target = effectiveInput.plans[0];
    if (target === undefined) throw new TransactionScopeError();
    const event: JournalEventInput = priorEvent !== null
      ? priorEvent
      : {
          version: 1,
          kind: "apply",
          event_id: effectiveInput.event_id,
          idempotency_key: effectiveInput.idempotency_key,
          created_at: nowIso(this.now),
          checkpoint: effectiveInput.checkpoint,
          planned_targets: [{ path: target.path, before_hash: target.before_hash, after_hash: target.after_hash }],
        };
    try {
      if (priorEvent === null) await this.journal.writeEvent(event);
    }
    catch (error) {
      if (error instanceof JournalIntegrityError) return this.outcomeFailed(effectiveInput, "io_error", target);
      throw error;
    }

    let held: LockHandle;
    try { held = await this.lock.acquire(); }
    catch (error) {
      if (error instanceof LockTimeoutError) return this.outcomeFailed(effectiveInput, "lock_unavailable", target);
      return this.outcomeFailed(effectiveInput, "io_error", target);
    }

    let operationOutcome: CheckpointOutcome | undefined;
    let operationError: unknown;
    try {
      // The pre-lock lookup is only an optimization. A concurrent winner may
      // have published a receipt while this invocation was waiting.
      const lockedExisting = await this.journal.findReceiptByIdempotency(effectiveInput.idempotency_key);
      operationOutcome = lockedExisting === null
        ? await this.applyLocked(effectiveInput, target)
        : this.outcomeFromReceipt(lockedExisting, effectiveInput.idempotency_key);
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    try { await held.release(); }
    catch (error) { releaseError = error; }

    if (releaseError !== undefined) {
      let persisted: { event_id: EventId; receipt: Receipt } | null;
      try { persisted = await this.journal.findReceiptByIdempotency(effectiveInput.idempotency_key); }
      catch { throw new TransactionIntegrityError(); }
      if (persisted?.receipt.outcome === "applied") {
        // The successful receipt is authoritative; do not write a contradictory
        // failed receipt after lock ownership became uncertain.
        throw new TransactionIntegrityError();
      }
      if (operationOutcome?.kind === "failed" && persisted?.receipt.outcome === "failed") {
        return operationOutcome;
      }
      if (persisted !== null) throw new TransactionIntegrityError();
      try { return await this.outcomeFailed(effectiveInput, "io_error", target); }
      catch { throw new TransactionIntegrityError(); }
    }
    if (operationError !== undefined) throw operationError;
    if (operationOutcome === undefined) throw new TransactionIntegrityError();
    return operationOutcome;
  }

  private async deferConflict(input: TransactionInput, targetPath: VaultPath): Promise<CheckpointOutcome> {
    let proposalPath: VaultPath;
    try { proposalPath = await this.writeConflictProposal(input, targetPath); }
    catch { return this.outcomeFailed(input, "io_error", input.plans[0]!); }
    const receipt = await this.journal.writeReceipt({ version: 1, outcome: "deferred_conflict", event_id: input.event_id, idempotency_key: input.idempotency_key, proposal_path: proposalPath, conflict_paths: [targetPath], targets: [{ path: targetPath, before_hash: input.plans[0]!.before_hash, after_hash: input.plans[0]!.after_hash }], created_at: nowIso(this.now) });
    if (receipt.outcome !== "deferred_conflict") throw new TransactionIntegrityError();
    return { kind: "deferred_conflict", event_id: input.event_id, receipt };
  }
}

type JournalEventInput = {
  version: 1;
  kind: "apply";
  event_id: EventId;
  idempotency_key: IdempotencyKey;
  created_at: ReturnType<typeof parseWithSchema<typeof IsoTimestampSchema>>;
  checkpoint: ApplyCheckpoint;
  planned_targets: Array<{ path: VaultPath; before_hash: HashHex | null; after_hash: HashHex }>;
};
