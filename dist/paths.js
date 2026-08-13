/**
 * Vault-relative path containment boundary (`VaultPaths`).
 *
 * Every note path entering the bridge is a normalized vault-relative POSIX
 * Markdown path. `VaultPaths` enforces, in order:
 *
 * 1. lexical containment — relative only, forward slashes, no dot/dotdot
 *    segments, no doubled/trailing slashes, no control characters, `.md`
 *    suffix, and no reserved internal segments (`.resyst`, `.stfolder`,
 *    `.git`); automatic reads additionally exclude the attachments
 *    directory;
 * 2. realpath containment — for reads, the existing parent and target must
 *    resolve inside the vault (symlink escape fails); for writes, the
 *    existing parent must resolve inside the vault and the target must not be
 *    a symlink (symlinked write targets are rejected even when contained);
 * 3. existence/type checks — reads require an existing file target; writes
 *    require an existing directory parent and a non-directory target.
 *
 * Errors are {@link VaultPathError}s with stable codes and fixed, redacted
 * messages that never echo the offending path or the vault location. Only
 * `ENOENT` maps to absence; every other filesystem failure at the public
 * boundary maps to `io_error`. A successful resolve is a validation snapshot,
 * not an authorization token: callers must revalidate path/hash/structure at
 * the final I/O seam (the Task 8 transaction service does this under the
 * local lock).
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
/** Default Obsidian attachments directory name. */
export const DEFAULT_ATTACHMENTS_DIR = "_adjuntos";
/** Required Markdown suffix for every note path accepted by VaultPaths. */
export const MARKDOWN_SUFFIX = ".md";
/** Fixed, redacted messages keyed by {@link VaultPathErrorCode}. */
const VAULT_PATH_ERROR_MESSAGES = {
    empty: "vault path is empty",
    not_relative: "vault path must be vault-relative",
    traversal: "vault path must not traverse upward",
    malformed: "vault path is not normalized",
    not_markdown: "vault path must reference a Markdown note",
    reserved: "vault path references a reserved internal path",
    attachments_automatic: "attachment paths require an explicit read",
    symlink_escape: "vault path escapes the vault through a symlink",
    symlink_target: "vault path resolves through a symlinked target",
    target_missing: "vault note does not exist",
    target_not_file: "vault path is not a file",
    target_is_directory: "vault path is a directory",
    parent_missing: "vault path parent does not exist",
    parent_not_directory: "vault path parent is not a directory",
    io_error: "vault path failed with an io error",
};
/** Fixed, redacted error for a rejected vault path; never echoes values. */
export class VaultPathError extends Error {
    code;
    constructor(code) {
        super(VAULT_PATH_ERROR_MESSAGES[code]);
        this.name = "VaultPathError";
        this.code = code;
    }
}
/**
 * Node `fs/promises` adapter for {@link VaultPathsFs}. `stat`/`lstat` use the
 * `bigint: true` option so `dev`/`ino` are exact `bigint` values end-to-end.
 */
export const nodeVaultPathsFs = {
    realpath,
    stat: (filePath) => stat(filePath, { bigint: true }),
    lstat: (filePath) => lstat(filePath, { bigint: true }),
};
const RESERVED_SEGMENTS = new Set([".resyst", ".stfolder", ".git"]);
/**
 * Lexically validate a vault-relative POSIX Markdown path and return its
 * normalized segments, or throw a redacted {@link VaultPathError}. Runs
 * before any filesystem access.
 */
function lexicalSegments(input, automatic, attachmentsDir) {
    if (typeof input !== "string" || input.length === 0) {
        throw new VaultPathError("empty");
    }
    if (input.startsWith("/") || input.includes("\\")) {
        throw new VaultPathError("not_relative");
    }
    if (input.length > 1024 || /[\u0000-\u001F\u007F]/.test(input)) {
        throw new VaultPathError("malformed");
    }
    const segments = input.split("/");
    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new VaultPathError("traversal");
        }
        if (segment === "") {
            throw new VaultPathError("malformed");
        }
        if (RESERVED_SEGMENTS.has(segment)) {
            throw new VaultPathError("reserved");
        }
    }
    if (automatic && (input === attachmentsDir || input.startsWith(`${attachmentsDir}/`))) {
        throw new VaultPathError("attachments_automatic");
    }
    if (!input.endsWith(MARKDOWN_SUFFIX)) {
        throw new VaultPathError("not_markdown");
    }
    return segments;
}
/**
 * Lexically validate a vault-relative directory path. Directory validation is
 * intentionally separate from note validation: directories have no `.md`
 * suffix, but retain the same relative/normalized/reserved-segment contract.
 */
function lexicalDirectorySegments(input, automatic, attachmentsDir) {
    if (typeof input !== "string" || input.length === 0) {
        throw new VaultPathError("empty");
    }
    if (input.startsWith("/") || input.includes("\\")) {
        throw new VaultPathError("not_relative");
    }
    if (input.length > 1024 || /[\u0000-\u001F\u007F]/.test(input)) {
        throw new VaultPathError("malformed");
    }
    const segments = input.split("/");
    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new VaultPathError("traversal");
        }
        if (segment === "") {
            throw new VaultPathError("malformed");
        }
        if (RESERVED_SEGMENTS.has(segment)) {
            throw new VaultPathError("reserved");
        }
    }
    if (automatic && (input === attachmentsDir || input.startsWith(`${attachmentsDir}/`))) {
        throw new VaultPathError("attachments_automatic");
    }
    return segments;
}
export class VaultPaths {
    vaultRoot;
    attachmentsDir;
    fs;
    /** Trusted identity established by config validation; never first-use. */
    trustedIdentity;
    constructor(vaultRoot, options) {
        this.vaultRoot = vaultRoot;
        this.attachmentsDir = options.attachmentsDir ?? DEFAULT_ATTACHMENTS_DIR;
        this.fs = options.fs ?? nodeVaultPathsFs;
        this.trustedIdentity = options.identity;
    }
    /**
     * Establish the CURRENT root identity: realpath plus dev/ino of the
     * configured root. Failures to establish identity (vanished root, EACCES,
     * EIO) surface as the fixed redacted `io_error`; a root that is no longer a
     * directory cannot establish the vault identity.
     */
    async currentRootIdentity() {
        let real;
        try {
            real = await this.fs.realpath(this.vaultRoot);
        }
        catch {
            throw new VaultPathError("io_error");
        }
        let rootStat;
        try {
            rootStat = await this.fs.stat(this.vaultRoot);
        }
        catch {
            throw new VaultPathError("io_error");
        }
        if (!rootStat.isDirectory()) {
            throw new VaultPathError("symlink_escape");
        }
        return { real_path: real, dev: rootStat.dev, ino: rootStat.ino };
    }
    /**
     * Re-establish the current root identity on every resolve — including the
     * first — and compare it to the config-validated trusted identity. A
     * retargeted symlink, renamed-away root, or same-pathname replacement
     * changes the realpath or the dev/ino and is rejected with
     * `symlink_escape`; the replacement is never blessed as the trusted root.
     */
    async verifiedVaultReal() {
        const current = await this.currentRootIdentity();
        if (current.real_path !== this.trustedIdentity.real_path ||
            current.dev !== this.trustedIdentity.dev ||
            current.ino !== this.trustedIdentity.ino) {
            throw new VaultPathError("symlink_escape");
        }
        return this.trustedIdentity.real_path;
    }
    isWithin(realPath, vaultReal) {
        return realPath === vaultReal || realPath.startsWith(`${vaultReal}/`);
    }
    /**
     * Validate an existing vault-relative directory immediately before a
     * directory read. This is the directory counterpart to `resolveRead`: it
     * re-establishes the config-trusted root identity, checks parent/target
     * realpath containment, and requires the followed target to be a directory.
     * The result is a validation snapshot, not an atomic authorization token.
     */
    async resolveDirectory(input, options = {}) {
        const segments = lexicalDirectorySegments(input, options.automatic ?? false, this.attachmentsDir);
        const vaultReal = await this.verifiedVaultReal();
        const absolute = path.join(this.vaultRoot, ...segments);
        const parentAbs = path.dirname(absolute);
        const parentReal = await this.realpathOrThrow(parentAbs, "target_missing");
        if (!this.isWithin(parentReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        const targetReal = await this.realpathOrThrow(absolute, "target_missing");
        if (!this.isWithin(targetReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        const linkStat = await this.lstatOrThrow(absolute, "target_missing");
        if (!linkStat.isSymbolicLink() && !linkStat.isDirectory()) {
            throw new VaultPathError("target_not_file");
        }
        const followStat = await this.statOrThrow(absolute, "target_missing");
        if (!followStat.isDirectory()) {
            throw new VaultPathError("target_not_file");
        }
        return { absolute };
    }
    /** Resolve a note for reading; the target must exist and stay contained. */
    async resolveRead(input, options = {}) {
        const segments = lexicalSegments(input, options.automatic ?? false, this.attachmentsDir);
        const vaultReal = await this.verifiedVaultReal();
        const absolute = path.join(this.vaultRoot, ...segments);
        const parentAbs = path.dirname(absolute);
        const parentReal = await this.realpathOrThrow(parentAbs, "target_missing");
        if (!this.isWithin(parentReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        const targetReal = await this.realpathOrThrow(absolute, "target_missing");
        if (!this.isWithin(targetReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        const linkStat = await this.lstatOrThrow(absolute, "target_missing");
        if (!linkStat.isSymbolicLink() && !linkStat.isFile()) {
            throw new VaultPathError("target_not_file");
        }
        const followStat = await this.statOrThrow(absolute, "target_missing");
        if (!followStat.isFile()) {
            throw new VaultPathError("target_not_file");
        }
        return { vaultRelative: input, absolute };
    }
    /** Resolve a note for writing; the parent must exist, the target must not be a symlink. */
    async resolveWrite(input) {
        const segments = lexicalSegments(input, false, this.attachmentsDir);
        const vaultReal = await this.verifiedVaultReal();
        const absolute = path.join(this.vaultRoot, ...segments);
        // Every write validates its current parent — including root-level writes,
        // whose parent is the (re-verified) vault root itself.
        const parentSegments = segments.slice(0, -1);
        const parentAbs = parentSegments.length === 0
            ? this.vaultRoot
            : path.join(this.vaultRoot, ...parentSegments);
        const parentReal = await this.realpathOrThrow(parentAbs, "parent_missing");
        if (!this.isWithin(parentReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        const parentStat = await this.statOrThrow(parentAbs, "parent_missing");
        if (!parentStat.isDirectory()) {
            throw new VaultPathError("parent_not_directory");
        }
        let linkStat;
        try {
            linkStat = await this.fs.lstat(absolute);
        }
        catch (error) {
            if (errorIsCode(error, "ENOENT")) {
                // New file under a validated existing parent.
                return { vaultRelative: input, absolute };
            }
            throw new VaultPathError("io_error");
        }
        if (linkStat.isSymbolicLink()) {
            // A symlinked write target is rejected; escaping symlinks report the
            // more severe containment violation.
            const targetReal = await this.realpathOrThrow(absolute, "target_missing");
            if (!this.isWithin(targetReal, vaultReal)) {
                throw new VaultPathError("symlink_escape");
            }
            throw new VaultPathError("symlink_target");
        }
        if (linkStat.isDirectory()) {
            throw new VaultPathError("target_is_directory");
        }
        if (!linkStat.isFile()) {
            // FIFOs, sockets, devices, and other non-regular targets are rejected
            // before any realpath or write can touch them.
            throw new VaultPathError("target_not_file");
        }
        const targetReal = await this.realpathOrThrow(absolute, "target_missing");
        if (!this.isWithin(targetReal, vaultReal)) {
            throw new VaultPathError("symlink_escape");
        }
        return { vaultRelative: input, absolute };
    }
    /**
     * Resolve the real path of an existing path. Only `ENOENT` maps to the
     * supplied absence code; every other failure becomes the fixed redacted
     * {@link VaultPathErrorCode.io_error} so no raw Node error or path leaks.
     */
    async realpathOrThrow(filePath, absentCode) {
        try {
            return await this.fs.realpath(filePath);
        }
        catch (error) {
            if (errorIsCode(error, "ENOENT")) {
                throw new VaultPathError(absentCode);
            }
            throw new VaultPathError("io_error");
        }
    }
    /** lstat wrapper with the same ENOENT/io_error mapping as realpath. */
    async lstatOrThrow(filePath, absentCode) {
        try {
            return await this.fs.lstat(filePath);
        }
        catch (error) {
            if (errorIsCode(error, "ENOENT")) {
                throw new VaultPathError(absentCode);
            }
            throw new VaultPathError("io_error");
        }
    }
    /** stat wrapper with the same ENOENT/io_error mapping as realpath. */
    async statOrThrow(filePath, absentCode) {
        try {
            return await this.fs.stat(filePath);
        }
        catch (error) {
            if (errorIsCode(error, "ENOENT")) {
                throw new VaultPathError(absentCode);
            }
            throw new VaultPathError("io_error");
        }
    }
}
/** Narrow a thrown `unknown` to its Node error code, if any. */
function errorIsCode(error, code) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code);
}
