/** Immutable, schema-validated journal and receipt persistence. */
import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  EventIdSchema,
  IdempotencyKeySchema,
  parseJournalEvent,
  parseReceipt,
  parseWithSchema,
} from "./schemas.js";
import type { VaultRootIdentity } from "./paths.js";
import type {
  EventId,
  IdempotencyKey,
  JournalEvent,
  Receipt,
} from "./types.js";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_MONTHS = 240;

export interface JournalStoreOptions {
  /** Vault root containing `.resyst/journal` and `.resyst/receipts`. */
  vaultRoot: string;
  /** Config-validated root identity; pathname trust is never inferred here. */
  identity: VaultRootIdentity;
  /** Timestamp used only for diagnostics/temp names; records use created_at. */
  now?: () => string;
}

export interface ReceiptLookup {
  event_id: EventId;
  receipt: Receipt;
}

export class JournalIntegrityError extends Error {
  constructor() {
    super("journal integrity check failed; details redacted");
    this.name = "JournalIntegrityError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function monthFromIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new JournalIntegrityError();
  return `${String(parsed.getUTCFullYear()).padStart(4, "0")}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}`;
}

function eventId(value: unknown): EventId {
  try { return parseWithSchema(EventIdSchema, value, "journal event id"); }
  catch { throw new JournalIntegrityError(); }
}

function idempotencyKey(value: unknown): IdempotencyKey {
  try { return parseWithSchema(IdempotencyKeySchema, value, "journal idempotency key"); }
  catch { throw new JournalIntegrityError(); }
}

function isSafeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

function boundedMonths(names: string[]): { valid: string[]; invalid: string[] } {
  const valid = names.filter(isMonth).sort();
  const invalid = names.filter((name) => !isMonth(name));
  if (valid.length > MAX_MONTHS || invalid.length > MAX_MONTHS) throw new JournalIntegrityError();
  return { valid, invalid };
}

async function directorySync(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP") throw new JournalIntegrityError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Ensure each component is a real, private directory. Recursive mkdir alone
 * is insufficient because it follows a pre-existing symlink.
 */
async function ensureDirectoryChain(root: string, parts: string[]): Promise<string> {
  const rootAbsolute = path.resolve(root);
  let current = rootAbsolute;
  let rootStat;
  try { rootStat = await lstat(current, { bigint: true }); }
  catch { throw new JournalIntegrityError(); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new JournalIntegrityError();
  for (const part of parts) {
    if (!/^[A-Za-z0-9._ -]{1,255}$/u.test(part) || part === "." || part === "..") {
      throw new JournalIntegrityError();
    }
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) throw new JournalIntegrityError();
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if (!isMissing(mkdirError) && errorCode(mkdirError) !== "EEXIST") throw new JournalIntegrityError();
      }
      try { stat = await lstat(current, { bigint: true }); } catch { throw new JournalIntegrityError(); }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalIntegrityError();
    try { await chmod(current, 0o700); } catch { throw new JournalIntegrityError(); }
  }
  return current;
}

/** Validate an existing directory chain without creating or chmod-ing anything. */
async function existingDirectoryChain(root: string, parts: string[]): Promise<boolean> {
  const rootAbsolute = path.resolve(root);
  let current = rootAbsolute;
  for (const part of parts) {
    if (!/^[A-Za-z0-9._ -]{1,255}$/u.test(part) || part === "." || part === "..") {
      throw new JournalIntegrityError();
    }
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) {
      if (isMissing(error)) return false;
      throw new JournalIntegrityError();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalIntegrityError();
  }
  return true;
}

async function regularRecordPath(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink()) throw new JournalIntegrityError();
    return stat.isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    if (error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError();
  }
}

async function readRawRecord(filePath: string): Promise<string | null> {
  const exists = await regularRecordPath(filePath);
  if (!exists) return null;
  let raw: string;
  try { raw = await readFile(filePath, "utf8"); }
  catch { throw new JournalIntegrityError(); }
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw new JournalIntegrityError();
  return raw;
}

function safeJson(record: JournalEvent | Receipt): string {
  try {
    // No diagnostic fields, absolute paths, note text, or process objects are
    // added: only the schema-approved record is persisted.
    return JSON.stringify(record);
  } catch { throw new JournalIntegrityError(); }
}

async function publishImmutable(directory: string, filename: string, contents: string): Promise<string> {
  if (!isSafeName(filename.replace(/\.json$/u, "")) || !filename.endsWith(".json")) {
    throw new JournalIntegrityError();
  }
  const destination = path.join(directory, filename);
  const temporary = path.join(
    directory,
    `.${filename}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let handle: FileHandle | undefined;
  try {
    try { handle = await open(temporary, "wx", 0o600); }
    catch { throw new JournalIntegrityError(); }
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // hardlink is deliberately used instead of rename: it never replaces a
      // pre-existing record, even if another host/process raced us.
      await link(temporary, destination);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new JournalIntegrityError();
      const existing = await readRawRecord(destination);
      if (existing !== contents) throw new JournalIntegrityError();
    }
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw new JournalIntegrityError();
    });
    await directorySync(directory);
    return destination;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError();
  }
}

function parsedEvent(raw: string): JournalEvent {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new JournalIntegrityError(); }
  try { return parseJournalEvent(value); } catch { throw new JournalIntegrityError(); }
}

function parsedReceipt(raw: string): Receipt {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new JournalIntegrityError(); }
  try { return parseReceipt(value); } catch { throw new JournalIntegrityError(); }
}

interface RecordLocation {
  month: string;
  filename: string;
  absolute: string;
}

/**
 * The store intentionally does not append: every event/receipt gets its own
 * immutable path, making cross-host sync conflict-free at the file level.
 */
export class JournalStore {
  readonly vaultRoot: string;
  readonly journalRoot: string;
  readonly receiptsRoot: string;
  private readonly identity: VaultRootIdentity;
  private readonly now: () => string;

  constructor(options: JournalStoreOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.journalRoot = path.join(this.vaultRoot, ".resyst", "journal");
    this.receiptsRoot = path.join(this.vaultRoot, ".resyst", "receipts");
    this.identity = options.identity;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async verifyRoot(): Promise<void> {
    let resolved: string;
    let rootStat;
    try {
      const fs = await import("node:fs/promises");
      resolved = await fs.realpath(this.vaultRoot);
      rootStat = await fs.stat(this.vaultRoot, { bigint: true });
    } catch { throw new JournalIntegrityError(); }
    if (
      !rootStat.isDirectory() ||
      resolved !== this.identity.real_path ||
      rootStat.dev !== this.identity.dev ||
      rootStat.ino !== this.identity.ino
    ) throw new JournalIntegrityError();
  }

  private async monthDirectory(root: string, month: string): Promise<string> {
    if (!isMonth(month)) throw new JournalIntegrityError();
    await ensureDirectoryChain(this.vaultRoot, [".resyst", path.basename(root), month]);
    return path.join(root, month);
  }


  private async readRootDirectory(root: string): Promise<boolean> {
    const basename = path.basename(root);
    if (basename !== "journal" && basename !== "receipts") throw new JournalIntegrityError();
    return existingDirectoryChain(this.vaultRoot, [".resyst", basename]);
  }

  private async readMonthDirectory(root: string, month: string): Promise<string> {
    if (!isMonth(month)) throw new JournalIntegrityError();
    const exists = await existingDirectoryChain(this.vaultRoot, [".resyst", path.basename(root), month]);
    if (!exists) throw new JournalIntegrityError();
    return path.join(root, month);
  }

  private async locations(root: string, filename: string): Promise<RecordLocation[]> {
    if (!(await this.readRootDirectory(root))) return [];
    let months: string[];
    try { months = await readdir(root); } catch { throw new JournalIntegrityError(); }
    const { valid } = boundedMonths(months);
    const result: RecordLocation[] = [];
    for (const month of valid) {
      const directory = await this.readMonthDirectory(root, month);
      const absolute = path.join(directory, filename);
      if (await regularRecordPath(absolute)) result.push({ month, filename, absolute });
    }
    return result;
  }

  async writeEvent(value: unknown): Promise<JournalEvent> {
    await this.verifyRoot();
    let event: JournalEvent;
    try { event = parseJournalEvent(value); } catch { throw new JournalIntegrityError(); }
    const month = monthFromIso(event.created_at);
    const directory = await this.monthDirectory(this.journalRoot, month);
    const filename = `${event.event_id}.json`;
    const serialized = safeJson(event);
    const destination = path.join(directory, filename);
    const existing = await readRawRecord(destination);
    if (existing !== null) {
      if (existing !== serialized) throw new JournalIntegrityError();
      return parsedEvent(existing);
    }
    await publishImmutable(directory, filename, serialized);
    const written = await readRawRecord(destination);
    if (written === null || written !== serialized) throw new JournalIntegrityError();
    return parsedEvent(written);
  }

  async readEvent(value: unknown): Promise<JournalEvent> {
    await this.verifyRoot();
    const id = eventId(value);
    const found = await this.locations(this.journalRoot, `${id}.json`);
    if (found.length !== 1) throw new JournalIntegrityError();
    const raw = await readRawRecord(found[0]!.absolute);
    if (raw === null) throw new JournalIntegrityError();
    const event = parsedEvent(raw);
    if (event.event_id !== id) throw new JournalIntegrityError();
    return event;
  }

  async writeReceipt(value: unknown): Promise<Receipt> {
    await this.verifyRoot();
    let receipt: Receipt;
    try { receipt = parseReceipt(value); } catch { throw new JournalIntegrityError(); }
    const month = monthFromIso(receipt.created_at);
    const directory = await this.monthDirectory(this.receiptsRoot, month);
    const filename = `${receipt.event_id}.json`;
    const serialized = safeJson(receipt);
    const destination = path.join(directory, filename);
    const existing = await readRawRecord(destination);
    if (existing !== null) {
      if (existing !== serialized) throw new JournalIntegrityError();
      return parsedReceipt(existing);
    }
    await publishImmutable(directory, filename, serialized);
    const written = await readRawRecord(destination);
    if (written === null || written !== serialized) throw new JournalIntegrityError();
    return parsedReceipt(written);
  }

  async readReceipt(value: unknown): Promise<Receipt> {
    await this.verifyRoot();
    const id = eventId(value);
    const found = await this.locations(this.receiptsRoot, `${id}.json`);
    if (found.length !== 1) throw new JournalIntegrityError();
    const raw = await readRawRecord(found[0]!.absolute);
    if (raw === null) throw new JournalIntegrityError();
    const receipt = parsedReceipt(raw);
    if (receipt.event_id !== id) throw new JournalIntegrityError();
    return receipt;
  }

  /** Return the lexicographically deterministic receipt for an idempotency key. */
  async findReceiptByIdempotency(value: unknown): Promise<ReceiptLookup | null> {
    await this.verifyRoot();
    const key = idempotencyKey(value);
    if (!(await this.readRootDirectory(this.receiptsRoot))) return null;
    let months: string[];
    try { months = await readdir(this.receiptsRoot); } catch { throw new JournalIntegrityError(); }
    const { valid } = boundedMonths(months);
    const matches: ReceiptLookup[] = [];
    for (const month of valid) {
      const directory = await this.readMonthDirectory(this.receiptsRoot, month);
      let names: string[];
      try { names = await readdir(directory); } catch { throw new JournalIntegrityError(); }
      for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
        const raw = await readRawRecord(path.join(directory, name));
        if (raw === null) continue;
        const receipt = parsedReceipt(raw);
        if (receipt.idempotency_key === key) {
          matches.push({ event_id: receipt.event_id, receipt });
        }
      }
    }
    matches.sort((left, right) =>
      String(left.receipt.created_at).localeCompare(String(right.receipt.created_at)) ||
      String(left.event_id).localeCompare(String(right.event_id)) ||
      JSON.stringify(left.receipt).localeCompare(JSON.stringify(right.receipt)),
    );
    return matches[0] ?? null;
  }

  /** Deterministic event lookup, useful to recovery without guessing paths. */
  async findEventByIdempotency(value: unknown): Promise<JournalEvent | null> {
    await this.verifyRoot();
    const key = idempotencyKey(value);
    if (!(await this.readRootDirectory(this.journalRoot))) return null;
    let months: string[];
    try { months = await readdir(this.journalRoot); } catch { throw new JournalIntegrityError(); }
    const { valid } = boundedMonths(months);
    const matches: JournalEvent[] = [];
    for (const month of valid) {
      const directory = await this.readMonthDirectory(this.journalRoot, month);
      let names: string[];
      try { names = await readdir(directory); } catch { throw new JournalIntegrityError(); }
      for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
        const raw = await readRawRecord(path.join(directory, name));
        if (raw === null) continue;
        const event = parsedEvent(raw);
        if (event.idempotency_key === key) matches.push(event);
      }
    }
    matches.sort((left, right) => String(left.event_id).localeCompare(String(right.event_id)));
    return matches[0] ?? null;
  }

  /** Exposes only validated, vault-relative journal roots for diagnostics. */
  getJournalRoot(): string { return ".resyst/journal"; }
  getReceiptsRoot(): string { return ".resyst/receipts"; }

  /** Keep the injected clock observable to transaction callers without writing it. */
  currentTime(): string { return this.now(); }
}
