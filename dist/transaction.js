/** Single-target, journal-first transactional vault apply. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { JournalIntegrityError, JournalStore } from "./journal.js";
import { LocalLock, LockTimeoutError } from "./lock.js";
import { VaultPaths, nodeVaultPathsFs } from "./paths.js";
import { EventIdSchema, HashHexSchema, IdempotencyKeySchema, IsoTimestampSchema, parseCheckpoint, parseWithSchema, VaultPathSchema, } from "./schemas.js";
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_RDONLY = fsConstants.O_RDONLY;
const O_WRONLY = fsConstants.O_WRONLY;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_PROGRESS_BYTES = 16 * 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
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
export class MissingProgressError extends Error {
    event_id;
    constructor(eventId) {
        super("transaction progress is not yet durable; details redacted");
        this.name = "MissingProgressError";
        this.event_id = eventId;
    }
}
function errorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function isMissing(error) { return errorCode(error) === "ENOENT"; }
function hashContent(value) {
    return parseWithSchema(HashHexSchema, createHash("sha256").update(value, "utf8").digest("hex"), "content hash");
}
function nowIso(now) {
    const value = now();
    if (!ISO_RE.test(value) || !Number.isFinite(new Date(value).getTime()))
        throw new TransactionIntegrityError();
    return parseWithSchema(IsoTimestampSchema, value, "transaction timestamp");
}
function safeRecordName(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
function isSafeVaultDirectory(value) {
    if (value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\"))
        return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." &&
        ![".resyst", ".git", ".stfolder"].includes(segment) &&
        !/[\u0000-\u001f\u007f]/u.test(segment));
}
function safeRelativePath(value) {
    try {
        return parseWithSchema(VaultPathSchema, value, "transaction target path");
    }
    catch {
        throw new TransactionIntegrityError();
    }
}
function safeEventId(value) {
    try {
        return parseWithSchema(EventIdSchema, value, "transaction event id");
    }
    catch {
        throw new TransactionIntegrityError();
    }
}
function safeKey(value) {
    try {
        return parseWithSchema(IdempotencyKeySchema, value, "transaction idempotency key");
    }
    catch {
        throw new TransactionIntegrityError();
    }
}
function safePlan(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TransactionIntegrityError();
    const record = value;
    const pathValue = safeRelativePath(record.path);
    const before = record.before_hash === null ? null : parseWithSchema(HashHexSchema, record.before_hash, "transaction before hash");
    const after = parseWithSchema(HashHexSchema, record.after_hash, "transaction after hash");
    if (typeof record.after_content !== "string" || record.after_content.length > 1_000_000)
        throw new TransactionIntegrityError();
    if (hashContent(record.after_content) !== after)
        throw new TransactionIntegrityError();
    const reasons = ["daily_create", "daily_update", "project_update", "landscape_moc", "landscape_claude", "association_proposal"];
    if (typeof record.reason !== "string" || !reasons.includes(record.reason))
        throw new TransactionIntegrityError();
    return { path: pathValue, before_hash: before, after_content: record.after_content, after_hash: after, reason: record.reason };
}
function narrowInput(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TransactionIntegrityError();
    const record = value;
    let checkpoint;
    try {
        checkpoint = parseCheckpoint(record.checkpoint);
    }
    catch {
        throw new TransactionIntegrityError();
    }
    if (checkpoint.kind !== "apply")
        throw new TransactionIntegrityError();
    if (!Array.isArray(record.plans) || record.plans.length < 1 || record.plans.length > 32)
        throw new TransactionScopeError();
    const plans = record.plans.map(safePlan).sort((left, right) => String(left.path).localeCompare(String(right.path)));
    if (new Set(plans.map((plan) => plan.path)).size !== plans.length)
        throw new TransactionScopeError();
    const event_id = safeEventId(record.event_id);
    const idempotency_key = safeKey(record.idempotency_key);
    const hooksValue = record.hooks;
    let hooks;
    if (hooksValue !== undefined) {
        if (typeof hooksValue !== "object" || hooksValue === null || Array.isArray(hooksValue))
            throw new TransactionIntegrityError();
        const hooksRecord = hooksValue;
        const beforeRename = hooksRecord.beforeRename;
        const afterRenamePreProgress = hooksRecord.afterRenamePreProgress;
        const afterRename = hooksRecord.afterRename;
        if ((beforeRename !== undefined && typeof beforeRename !== "function")
            || (afterRenamePreProgress !== undefined && typeof afterRenamePreProgress !== "function")
            || (afterRename !== undefined && typeof afterRename !== "function")) {
            throw new TransactionIntegrityError();
        }
        if (beforeRename !== undefined || afterRenamePreProgress !== undefined || afterRename !== undefined) {
            hooks = {
                ...(beforeRename === undefined ? {} : { beforeRename: beforeRename }),
                ...(afterRenamePreProgress === undefined ? {} : { afterRenamePreProgress: afterRenamePreProgress }),
                ...(afterRename === undefined ? {} : { afterRename: afterRename }),
            };
        }
    }
    const result = { checkpoint, idempotency_key, event_id, plans };
    if (hooks !== undefined)
        result.hooks = hooks;
    return result;
}
function defaultStateRoot() {
    return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}
async function ensurePrivateDirectory(root, directory) {
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
        try {
            directoryStat = await lstat(candidate, { bigint: true });
        }
        catch (error) {
            if (!isMissing(error))
                throw new TransactionIntegrityError();
            try {
                await mkdir(candidate, { mode: 0o700 });
            }
            catch (mkdirError) {
                if (errorCode(mkdirError) !== "EEXIST")
                    throw new TransactionIntegrityError();
            }
            try {
                directoryStat = await lstat(candidate, { bigint: true });
            }
            catch {
                throw new TransactionIntegrityError();
            }
        }
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new TransactionIntegrityError();
        try {
            await chmod(candidate, 0o700);
        }
        catch {
            throw new TransactionIntegrityError();
        }
    }
}
async function directorySync(directory) {
    let handle;
    try {
        handle = await open(directory, O_RDONLY);
        await handle.sync();
    }
    catch (error) {
        const code = errorCode(error);
        if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP")
            throw new TransactionIntegrityError();
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function readSnapshot(absolute) {
    let linkStat;
    try {
        linkStat = await lstat(absolute, { bigint: true });
    }
    catch (error) {
        if (isMissing(error))
            return { exists: false, content: "", hash: null, mode: 0o600, dev: null, ino: null };
        throw new TransactionIntegrityError();
    }
    if (linkStat.isSymbolicLink() || !linkStat.isFile())
        throw new TransactionIntegrityError();
    let handle;
    try {
        handle = await open(absolute, O_RDONLY | O_NOFOLLOW);
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== linkStat.dev || opened.ino !== linkStat.ino || !opened.isFile())
            throw new TransactionIntegrityError();
        const content = await handle.readFile("utf8");
        return {
            exists: true,
            content,
            hash: hashContent(content),
            mode: Number(opened.mode & 4095n),
            dev: opened.dev,
            ino: opened.ino,
        };
    }
    catch (error) {
        if (error instanceof TransactionIntegrityError)
            throw error;
        throw new TransactionIntegrityError();
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function backupSnapshot(stateRoot, directory, eventId, relative, snapshot) {
    const backupDirectory = path.join(directory, String(eventId));
    await ensurePrivateDirectory(stateRoot, backupDirectory);
    const encoded = Buffer.from(relative, "utf8").toString("base64url");
    if (!safeRecordName(encoded))
        throw new TransactionIntegrityError();
    const backupFile = snapshot.exists ? path.join(backupDirectory, `${encoded}.before`) : null;
    if (backupFile !== null) {
        let handle;
        try {
            handle = await open(backupFile, O_WRONLY | O_CREAT | O_EXCL, 0o600);
            await handle.writeFile(snapshot.content, "utf8");
            await handle.sync();
        }
        catch (error) {
            if (errorCode(error) !== "EEXIST")
                throw new TransactionIntegrityError();
            let existing;
            try {
                existing = await readFile(backupFile, "utf8");
            }
            catch {
                throw new TransactionIntegrityError();
            }
            if (existing !== snapshot.content)
                throw new TransactionIntegrityError();
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    const metadataPath = path.join(backupDirectory, `${encoded}.json`);
    const metadata = {
        version: 1,
        event_id: eventId,
        path: relative,
        existed: snapshot.exists,
        mode: snapshot.mode,
        before_hash: snapshot.hash,
        backup_file: backupFile === null ? null : path.basename(backupFile),
    };
    let metadataHandle;
    try {
        metadataHandle = await open(metadataPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
        await metadataHandle.writeFile(JSON.stringify(metadata), "utf8");
        await metadataHandle.sync();
    }
    catch (error) {
        if (errorCode(error) !== "EEXIST")
            throw new TransactionIntegrityError();
        let existing;
        try {
            existing = await readFile(metadataPath, "utf8");
        }
        catch {
            throw new TransactionIntegrityError();
        }
        if (existing !== JSON.stringify(metadata))
            throw new TransactionIntegrityError();
    }
    finally {
        await metadataHandle?.close().catch(() => undefined);
    }
    await directorySync(backupDirectory);
    return metadata;
}
function recordKey(relative) {
    const encoded = Buffer.from(relative, "utf8").toString("base64url");
    if (!safeRecordName(encoded))
        throw new TransactionIntegrityError();
    return encoded;
}
function progressPath(directory, relative) {
    return path.join(directory, `progress-${recordKey(relative)}.json`);
}
async function writeProgress(stateRoot, directory, record) {
    await ensurePrivateDirectory(stateRoot, directory);
    const destination = progressPath(directory, record.path);
    const temporary = path.join(directory, `.progress.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    const contents = JSON.stringify(record);
    if (Buffer.byteLength(contents, "utf8") > MAX_PROGRESS_BYTES)
        throw new TransactionIntegrityError();
    let handle;
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
    }
    catch {
        await handle?.close().catch(() => undefined);
        if (ownsTemporary)
            await unlink(temporary).catch(() => undefined);
        throw new TransactionIntegrityError();
    }
}
function parseProgressRecord(value, eventId, target) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TransactionIntegrityError();
    const record = value;
    const keys = ["version", "event_id", "path", "before_hash", "after_hash", "temp_name", "state"];
    if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record)))
        throw new TransactionIntegrityError();
    if (record.version !== 2 || record.event_id !== eventId || record.path !== target)
        throw new TransactionIntegrityError();
    let beforeHash;
    let afterHash;
    try {
        beforeHash = record.before_hash === null ? null : parseWithSchema(HashHexSchema, record.before_hash, "progress before hash");
        afterHash = parseWithSchema(HashHexSchema, record.after_hash, "progress after hash");
    }
    catch {
        throw new TransactionIntegrityError();
    }
    if (typeof record.temp_name !== "string" || !/^\.[A-Za-z0-9._-]{1,255}\.resyst-[A-Za-z0-9-]+$/u.test(record.temp_name))
        throw new TransactionIntegrityError();
    if (record.state !== "prepared" && record.state !== "renamed")
        throw new TransactionIntegrityError();
    const parsedEvent = safeEventId(record.event_id);
    const parsedPath = safeRelativePath(record.path);
    if (parsedEvent !== eventId || parsedPath !== target)
        throw new TransactionIntegrityError();
    return { version: 2, event_id: parsedEvent, path: parsedPath, before_hash: beforeHash, after_hash: afterHash, temp_name: record.temp_name, state: record.state };
}
async function existingPrivateDirectory(root, directory) {
    const rootAbsolute = path.resolve(root);
    const directoryAbsolute = path.resolve(directory);
    if (directoryAbsolute !== rootAbsolute && !directoryAbsolute.startsWith(`${rootAbsolute}${path.sep}`))
        throw new TransactionIntegrityError();
    const relative = path.relative(rootAbsolute, directoryAbsolute);
    const segments = relative.split(path.sep).filter((item) => item.length > 0);
    let current = rootAbsolute;
    for (const candidate of [current, ...segments.map((segment) => { current = path.join(current, segment); return current; })]) {
        let directoryStat;
        try {
            directoryStat = await lstat(candidate, { bigint: true });
        }
        catch (error) {
            if (isMissing(error))
                return false;
            throw new TransactionIntegrityError();
        }
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new TransactionIntegrityError();
    }
    return true;
}
async function readProgress(stateRoot, directory, eventId, target) {
    if (!(await existingPrivateDirectory(stateRoot, directory)))
        return null;
    const destination = progressPath(directory, target);
    let progressStat;
    try {
        progressStat = await lstat(destination, { bigint: true });
    }
    catch (error) {
        if (isMissing(error))
            return null;
        throw new TransactionIntegrityError();
    }
    if (!progressStat.isFile() || progressStat.isSymbolicLink())
        throw new TransactionIntegrityError();
    let raw;
    try {
        raw = await readFile(destination, "utf8");
    }
    catch {
        throw new TransactionIntegrityError();
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_PROGRESS_BYTES)
        throw new TransactionIntegrityError();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new TransactionIntegrityError();
    }
    return parseProgressRecord(parsed, eventId, target);
}
async function hasConflictCopy(parent, basename) {
    let entries;
    try {
        entries = await readdir(parent);
    }
    catch {
        throw new TransactionIntegrityError();
    }
    const extension = path.extname(basename);
    const stem = extension.length > 0 ? basename.slice(0, -extension.length) : basename;
    return entries.some((name) => name.startsWith(`${stem}.sync-conflict-`) &&
        (extension.length === 0 || name.endsWith(extension)));
}
function proposalData(value) {
    return value
        .trim()
        .replace(/\s+/gu, " ")
        .replaceAll("<", "&lt;")
        .replace(/[\\`*_\[\]|]/gu, "\\$&");
}
function proposalText(input, target) {
    const lines = [
        "# Resyst Vault Bridge — pending association",
        "",
        `event: ${proposalData(input.event_id)}`,
        `target: ${proposalData(target)}`,
        "",
        "## Proposed facts",
    ];
    for (const collection of Object.values(input.checkpoint.knowledge)) {
        for (const item of collection)
            lines.push(`- ${proposalData(item.text)}`);
    }
    lines.push("", "## Evidence");
    for (const collection of Object.values(input.checkpoint.evidence)) {
        for (const item of collection)
            lines.push(`- ${proposalData(item.id)}: ${proposalData(item.value)}`);
    }
    const result = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(result, "utf8") > MAX_PROPOSAL_BYTES)
        throw new TransactionIntegrityError();
    return result;
}
function narrowNoopInput(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransactionIntegrityError();
    }
    const record = value;
    let checkpoint;
    try {
        checkpoint = parseCheckpoint(record.checkpoint);
    }
    catch {
        throw new TransactionIntegrityError();
    }
    if (checkpoint.kind !== "noop")
        throw new TransactionIntegrityError();
    return {
        checkpoint,
        event_id: safeEventId(record.event_id),
        idempotency_key: safeKey(record.idempotency_key),
    };
}
function sameApplyIntent(event, input) {
    if (event.kind !== "apply" ||
        event.event_id !== input.event_id ||
        event.idempotency_key !== input.idempotency_key)
        return false;
    const targets = input.plans.map((plan) => ({
        path: plan.path,
        before_hash: plan.before_hash,
        after_hash: plan.after_hash,
    }));
    return isDeepStrictEqual(event.checkpoint, input.checkpoint) &&
        isDeepStrictEqual(event.planned_targets, targets);
}
export class TransactionService {
    vaultRoot;
    stateRoot;
    backupRoot;
    journal;
    lock;
    pathsPromise;
    inboxDir;
    now;
    beforeRename;
    afterRenamePreProgress;
    afterRename;
    constructor(options) {
        this.vaultRoot = path.resolve(options.vaultRoot);
        this.stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot());
        this.backupRoot = path.join(this.stateRoot, "resyst-vault", "backups");
        const trustedIdentity = options.config?.vault_identity ?? options.identity;
        if (options.journal === undefined && trustedIdentity === undefined)
            throw new TransactionIntegrityError();
        this.journal = options.journal ?? (options.now === undefined
            ? new JournalStore({ vaultRoot: this.vaultRoot, identity: trustedIdentity })
            : new JournalStore({ vaultRoot: this.vaultRoot, identity: trustedIdentity, now: options.now }));
        this.lock = options.lock ?? new LocalLock({ stateRoot: this.stateRoot });
        this.now = options.now ?? (() => new Date().toISOString());
        if (options.beforeRename !== undefined)
            this.beforeRename = options.beforeRename;
        if (options.afterRenamePreProgress !== undefined)
            this.afterRenamePreProgress = options.afterRenamePreProgress;
        if (options.afterRename !== undefined)
            this.afterRename = options.afterRename;
        const trustedPaths = options.paths ?? (options.config !== undefined
            ? new VaultPaths(this.vaultRoot, {
                identity: options.config.vault_identity,
                attachmentsDir: options.config.layout.attachments_dir,
            })
            : options.identity !== undefined
                ? new VaultPaths(this.vaultRoot, { identity: options.identity, fs: nodeVaultPathsFs })
                : null);
        if (trustedPaths === null)
            throw new TransactionIntegrityError();
        this.pathsPromise = Promise.resolve(trustedPaths);
        const inboxDir = options.config?.layout.inbox_dir ?? options.inboxDir;
        if (inboxDir === undefined || !isSafeVaultDirectory(inboxDir))
            throw new TransactionIntegrityError();
        this.inboxDir = inboxDir;
    }
    async writeConflictProposal(input, target) {
        const proposalPath = safeRelativePath(`${this.inboxDir}/resyst-proposal-${input.event_id}.md`);
        const paths = await this.pathsPromise;
        const resolved = await paths.resolveWrite(proposalPath);
        const content = proposalText(input, target);
        const snapshot = await readSnapshot(resolved.absolute);
        if (snapshot.exists) {
            if (snapshot.content !== content)
                throw new TransactionIntegrityError();
            return proposalPath;
        }
        await this.writeAtomic(resolved.absolute, content, 0o600, snapshot, undefined);
        return proposalPath;
    }
    async prepareAtomic(absolute, content, mode, expected) {
        const parent = path.dirname(absolute);
        const current = await readSnapshot(absolute);
        if (current.exists !== expected.exists || current.hash !== expected.hash || (current.exists && (current.dev !== expected.dev || current.ino !== expected.ino)))
            throw new TransactionIntegrityError();
        const temporary = path.join(parent, `.${path.basename(absolute)}.resyst-${process.pid}-${randomBytes(8).toString("hex")}`);
        let handle;
        try {
            handle = await open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
            await handle.writeFile(content, "utf8");
            await handle.chmod(mode & 0o7777);
            await handle.sync();
            await handle.close();
            return temporary;
        }
        catch {
            await handle?.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw new TransactionIntegrityError();
        }
    }
    async publishAtomic(absolute, temporary, expected, hook) {
        try {
            if (path.dirname(temporary) !== path.dirname(absolute) || path.basename(temporary).includes(path.sep))
                throw new TransactionIntegrityError();
            if (hook !== undefined)
                await hook();
            const finalCheck = await readSnapshot(absolute);
            if (finalCheck.exists !== expected.exists || finalCheck.hash !== expected.hash || (finalCheck.exists && (finalCheck.dev !== expected.dev || finalCheck.ino !== expected.ino)))
                throw new TransactionIntegrityError();
            const temporaryStat = await lstat(temporary, { bigint: true });
            if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink())
                throw new TransactionIntegrityError();
            await rename(temporary, absolute);
            await directorySync(path.dirname(absolute));
        }
        catch (error) {
            if (error instanceof TransactionCrashError)
                throw error;
            throw new TransactionIntegrityError();
        }
    }
    async writeAtomic(absolute, content, mode, expected, hook) {
        const snapshot = expected ?? await readSnapshot(absolute);
        const temporary = await this.prepareAtomic(absolute, content, mode, snapshot);
        try {
            await this.publishAtomic(absolute, temporary, snapshot, hook);
        }
        catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
    }
    targets(input) {
        return input.plans.map((target) => ({ path: target.path, before_hash: target.before_hash, after_hash: target.after_hash }));
    }
    async outcomeFailed(input, reason) {
        const receipt = await this.journal.writeReceipt({ version: 1, outcome: "failed", event_id: input.event_id, idempotency_key: input.idempotency_key, reason, targets: this.targets(input), created_at: nowIso(this.now) });
        if (receipt.outcome !== "failed")
            throw new TransactionIntegrityError();
        return { kind: "failed", event_id: input.event_id, receipt };
    }
    outcomeFromReceipt(existing, idempotencyKey) {
        switch (existing.receipt.outcome) {
            case "applied": return { kind: "already_applied", idempotency_key: idempotencyKey, original_event_id: existing.event_id, original_receipt: existing.receipt };
            case "deferred_conflict": return { kind: "deferred_conflict", event_id: existing.event_id, receipt: existing.receipt };
            case "failed": return { kind: "failed", event_id: existing.event_id, receipt: existing.receipt };
            default: throw new TransactionIntegrityError();
        }
    }
    async outcomeApplied(input) {
        const receipt = await this.journal.writeReceipt({ version: 1, outcome: "applied", event_id: input.event_id, idempotency_key: input.idempotency_key, targets: this.targets(input), created_at: nowIso(this.now) });
        if (receipt.outcome !== "applied")
            throw new TransactionIntegrityError();
        return { kind: "applied", event_id: input.event_id, receipt };
    }
    async applyLocked(input) {
        const paths = await this.pathsPromise;
        const progressDirectory = path.join(this.backupRoot, String(input.event_id));
        const prepared = [];
        const conflicts = [];
        const staleTemps = [];
        for (const plan of input.plans) {
            let resolved;
            try {
                resolved = await paths.resolveWrite(plan.path);
            }
            catch {
                conflicts.push(plan.path);
                continue;
            }
            let progress;
            try {
                progress = await readProgress(this.stateRoot, progressDirectory, input.event_id, plan.path);
            }
            catch {
                throw new ProgressIntegrityError();
            }
            if (progress !== null && (progress.before_hash !== plan.before_hash || progress.after_hash !== plan.after_hash))
                throw new ProgressIntegrityError();
            const current = await readSnapshot(resolved.absolute);
            if (progress !== null && current.exists && current.hash === plan.after_hash) {
                if (progress.state === "prepared") {
                    progress = { ...progress, state: "renamed" };
                    await writeProgress(this.stateRoot, progressDirectory, progress);
                }
                prepared.push({ plan, absolute: resolved.absolute, before: current, progress });
                continue;
            }
            if (await hasConflictCopy(path.dirname(resolved.absolute), path.basename(resolved.absolute))) {
                if (progress?.state === "prepared")
                    staleTemps.push({ absolute: resolved.absolute, temp_name: progress.temp_name });
                conflicts.push(plan.path);
                continue;
            }
            if (current.hash !== plan.before_hash || current.exists !== (plan.before_hash !== null)) {
                if (progress?.state === "prepared")
                    staleTemps.push({ absolute: resolved.absolute, temp_name: progress.temp_name });
                conflicts.push(plan.path);
                continue;
            }
            await backupSnapshot(this.stateRoot, this.backupRoot, input.event_id, plan.path, current);
            let temporary;
            if (progress?.state === "prepared") {
                temporary = path.join(path.dirname(resolved.absolute), progress.temp_name);
                const temporaryStat = await lstat(temporary, { bigint: true }).catch(() => null);
                if (temporaryStat === null || !temporaryStat.isFile() || temporaryStat.isSymbolicLink())
                    throw new ProgressIntegrityError();
                let preparedContent;
                try {
                    preparedContent = await readFile(temporary, "utf8");
                }
                catch {
                    throw new ProgressIntegrityError();
                }
                if (hashContent(preparedContent) !== plan.after_hash)
                    throw new ProgressIntegrityError();
            }
            else {
                temporary = await this.prepareAtomic(resolved.absolute, plan.after_content, current.mode, current);
                progress = { version: 2, event_id: input.event_id, path: plan.path, before_hash: plan.before_hash, after_hash: plan.after_hash, temp_name: path.basename(temporary), state: "prepared" };
                await writeProgress(this.stateRoot, progressDirectory, progress);
            }
            prepared.push({ plan, absolute: resolved.absolute, before: current, progress });
        }
        if (conflicts.length > 0) {
            try {
                const cleanup = [
                    ...prepared.filter((item) => item.progress.state === "prepared").map((item) => ({ absolute: item.absolute, temp_name: item.progress.temp_name })),
                    ...staleTemps,
                ];
                for (const item of cleanup) {
                    await unlink(path.join(path.dirname(item.absolute), item.temp_name));
                    await directorySync(path.dirname(item.absolute));
                }
            }
            catch {
                return this.outcomeFailed(input, "io_error");
            }
            return this.deferConflict(input, conflicts);
        }
        for (let index = 0; index < prepared.length; index += 1) {
            const item = prepared[index];
            if (item.progress.state === "renamed")
                continue;
            const beforeRename = input.hooks?.beforeRename ?? this.beforeRename;
            try {
                await this.publishAtomic(item.absolute, path.join(path.dirname(item.absolute), item.progress.temp_name), item.before, beforeRename === undefined ? undefined : () => beforeRename(item.plan, index));
                // Crash seam: between durable rename and durable progress update. A
                // crash here leaves the file in the after state and progress in
                // "prepared"; the next apply recovers by observing the after hash and
                // rewriting progress to "renamed".
                const afterRenamePreProgress = input.hooks?.afterRenamePreProgress ?? this.afterRenamePreProgress;
                if (afterRenamePreProgress !== undefined)
                    await afterRenamePreProgress(item.plan, index);
                const renamed = { ...item.progress, state: "renamed" };
                await writeProgress(this.stateRoot, progressDirectory, renamed);
                const afterRename = input.hooks?.afterRename ?? this.afterRename;
                if (afterRename !== undefined)
                    await afterRename(item.plan, index);
            }
            catch (error) {
                if (error instanceof TransactionCrashError)
                    throw error;
                await unlink(path.join(path.dirname(item.absolute), item.progress.temp_name)).catch(() => undefined);
                return this.outcomeFailed(input, "io_error");
            }
        }
        return this.outcomeApplied(input);
    }
    /** Persist one immutable noop evaluation under the transaction lock. */
    async recordNoop(value) {
        const input = narrowNoopInput(value);
        let held;
        try {
            held = await this.lock.acquire();
        }
        catch {
            throw new TransactionIntegrityError();
        }
        let outcome;
        let operationError;
        try {
            const existing = await this.journal.findReceiptByIdempotency(input.idempotency_key);
            if (existing !== null) {
                if (existing.receipt.outcome !== "noop")
                    throw new TransactionIntegrityError();
                outcome = {
                    kind: "noop",
                    event_id: existing.event_id,
                    receipt: existing.receipt,
                    reason: input.checkpoint.reason,
                };
            }
            else {
                const prior = await this.journal.findEventByIdempotency(input.idempotency_key);
                if (prior !== null && prior.kind !== "noop")
                    throw new TransactionIntegrityError();
                const eventId = prior?.event_id ?? input.event_id;
                const event = prior ?? {
                    version: 1,
                    kind: "noop",
                    event_id: eventId,
                    idempotency_key: input.idempotency_key,
                    created_at: nowIso(this.now),
                    checkpoint: input.checkpoint,
                };
                if (prior === null)
                    await this.journal.writeEvent(event);
                const receipt = {
                    version: 1,
                    outcome: "noop",
                    event_id: eventId,
                    idempotency_key: input.idempotency_key,
                    created_at: nowIso(this.now),
                };
                const durable = await this.journal.writeReceipt(receipt);
                if (durable.outcome !== "noop" || durable.event_id !== eventId) {
                    throw new TransactionIntegrityError();
                }
                outcome = {
                    kind: "noop",
                    event_id: eventId,
                    receipt: durable,
                    reason: input.checkpoint.reason,
                };
            }
        }
        catch (error) {
            operationError = error;
        }
        let releaseError;
        try {
            await held.release();
        }
        catch (error) {
            releaseError = error;
        }
        if (releaseError !== undefined || operationError !== undefined || outcome === undefined) {
            throw new TransactionIntegrityError();
        }
        return outcome;
    }
    async apply(value) {
        const input = narrowInput(value);
        const existing = await this.journal.findReceiptByIdempotency(input.idempotency_key);
        if (existing !== null)
            return this.outcomeFromReceipt(existing, input.idempotency_key);
        let priorEvent = await this.journal.findEventByIdempotency(input.idempotency_key);
        if (priorEvent !== null && priorEvent.kind !== "apply") {
            throw new TransactionIntegrityError();
        }
        const effectiveEventId = priorEvent?.event_id ?? input.event_id;
        const effectiveInput = effectiveEventId === input.event_id
            ? input
            : { ...input, event_id: effectiveEventId };
        if (effectiveInput.plans.length === 0)
            throw new TransactionScopeError();
        const event = priorEvent !== null
            ? priorEvent
            : {
                version: 1,
                kind: "apply",
                event_id: effectiveInput.event_id,
                idempotency_key: effectiveInput.idempotency_key,
                created_at: nowIso(this.now),
                checkpoint: effectiveInput.checkpoint,
                planned_targets: this.targets(effectiveInput),
            };
        try {
            if (priorEvent === null)
                await this.journal.writeEvent(event);
        }
        catch (error) {
            if (!(error instanceof JournalIntegrityError))
                throw error;
            const concurrent = await this.journal.findEventByIdempotency(input.idempotency_key);
            if (concurrent === null || !sameApplyIntent(concurrent, effectiveInput)) {
                return this.outcomeFailed(effectiveInput, "io_error");
            }
            priorEvent = concurrent;
        }
        let held;
        try {
            held = await this.lock.acquire();
        }
        catch (error) {
            if (error instanceof LockTimeoutError)
                return this.outcomeFailed(effectiveInput, "lock_unavailable");
            return this.outcomeFailed(effectiveInput, "io_error");
        }
        let operationOutcome;
        let operationError;
        try {
            // The pre-lock lookup is only an optimization. A concurrent winner may
            // have published a receipt while this invocation was waiting.
            const lockedExisting = await this.journal.findReceiptByIdempotency(effectiveInput.idempotency_key);
            operationOutcome = lockedExisting === null
                ? await this.applyLocked(effectiveInput)
                : this.outcomeFromReceipt(lockedExisting, effectiveInput.idempotency_key);
        }
        catch (error) {
            operationError = error;
        }
        let releaseError;
        try {
            await held.release();
        }
        catch (error) {
            releaseError = error;
        }
        if (releaseError !== undefined) {
            let persisted;
            try {
                persisted = await this.journal.findReceiptByIdempotency(effectiveInput.idempotency_key);
            }
            catch {
                throw new TransactionIntegrityError();
            }
            if (persisted?.receipt.outcome === "applied") {
                // The successful receipt is authoritative; do not write a contradictory
                // failed receipt after lock ownership became uncertain.
                throw new TransactionIntegrityError();
            }
            if (operationOutcome?.kind === "failed" && persisted?.receipt.outcome === "failed") {
                return operationOutcome;
            }
            if (persisted !== null)
                throw new TransactionIntegrityError();
            try {
                return await this.outcomeFailed(effectiveInput, "io_error");
            }
            catch {
                throw new TransactionIntegrityError();
            }
        }
        if (operationError !== undefined)
            throw operationError;
        if (operationOutcome === undefined)
            throw new TransactionIntegrityError();
        return operationOutcome;
    }
    /** Replay one journaled apply from durable prepared temp files.
     * Missing progress (including a mid-prepare frontier) stays pending and is
     * surfaced to the recovery batch as `MissingProgressError`; no terminal
     * receipt is invented. Corrupt or hash-mismatched durable progress remains
     * a fatal integrity error. */
    async recoverEvent(event) {
        if (event.kind !== "apply")
            throw new TransactionIntegrityError();
        const progressDirectory = path.join(this.backupRoot, String(event.event_id));
        const paths = await this.pathsPromise;
        const sortedTargets = [...event.planned_targets].sort((left, right) => String(left.path).localeCompare(String(right.path)));
        const progressByTarget = [];
        for (const target of sortedTargets) {
            // A directory that does not yet exist means the event never started a
            // prepared frontier for that target; map that to a recoverable
            // "missing_progress" outcome instead of treating it as corruption.
            const dirExists = await existingPrivateDirectory(this.stateRoot, progressDirectory);
            const progress = dirExists
                ? await readProgress(this.stateRoot, progressDirectory, event.event_id, target.path)
                : null;
            progressByTarget.push({ target, progress });
        }
        const missing = progressByTarget.filter((entry) => entry.progress === null);
        const present = progressByTarget.filter((entry) => entry.progress !== null);
        if (missing.length > 0)
            throw new MissingProgressError(event.event_id);
        const plans = [];
        for (const entry of present) {
            const progress = entry.progress;
            const target = entry.target;
            if (progress.before_hash !== target.before_hash || progress.after_hash !== target.after_hash)
                throw new ProgressIntegrityError();
            const resolved = await paths.resolveWrite(target.path);
            let afterContent;
            const current = await readSnapshot(resolved.absolute);
            if (current.hash === target.after_hash)
                afterContent = current.content;
            else {
                const temporary = path.join(path.dirname(resolved.absolute), progress.temp_name);
                let prepared;
                try {
                    prepared = await readFile(temporary, "utf8");
                }
                catch {
                    throw new ProgressIntegrityError();
                }
                if (hashContent(prepared) !== target.after_hash)
                    throw new ProgressIntegrityError();
                afterContent = prepared;
            }
            plans.push({ path: target.path, before_hash: target.before_hash, after_hash: target.after_hash, after_content: afterContent, reason: "daily_update" });
        }
        return this.apply({ checkpoint: event.checkpoint, event_id: event.event_id, idempotency_key: event.idempotency_key, plans });
    }
    async deferConflict(input, conflictPaths) {
        const unique = [...new Set(conflictPaths)].sort();
        let proposalPath;
        try {
            proposalPath = await this.writeConflictProposal(input, unique[0] ?? input.plans[0].path);
        }
        catch {
            return this.outcomeFailed(input, "io_error");
        }
        const receipt = await this.journal.writeReceipt({ version: 1, outcome: "deferred_conflict", event_id: input.event_id, idempotency_key: input.idempotency_key, proposal_path: proposalPath, conflict_paths: unique, targets: this.targets(input), created_at: nowIso(this.now) });
        if (receipt.outcome !== "deferred_conflict")
            throw new TransactionIntegrityError();
        return { kind: "deferred_conflict", event_id: input.event_id, receipt };
    }
}
