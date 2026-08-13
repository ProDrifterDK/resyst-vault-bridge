/** Secure, bounded note snapshots shared by read and mutation facades. */
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { open, realpath as realpathFn, stat } from "node:fs/promises";
import { IsoTimestampSchema, VaultPathSchema, parseWithSchema } from "./schemas.js";
/** Snapshot reader redacted error; fixed messages, no payload values. */
export class SnapshotReadError extends Error {
    code;
    constructor(code) {
        super(`snapshot read failed: ${code}`);
        this.name = "SnapshotReadError";
        this.code = code;
    }
}
/**
 * Canonical open flags used by the snapshot reader. The combination rejects
 * every symlink at open time (`O_NOFOLLOW`), avoids blocking on FIFOs or
 * devices (`O_NONBLOCK` — only relevant when the path is a special file,
 * which is rejected immediately after `fstat`), and never requests write
 * access (`O_RDONLY`).
 */
export const SNAPSHOT_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/**
 * Production adapter for {@link SnapshotFs} backed by `node:fs/promises`.
 * Raw Node errors are collapsed to {@link SnapshotReadError.io_error}; the
 * caller never sees an `ENOENT`, `ELOOP`, or `EACCES` text outside this
 * adapter.
 */
export const nodeSnapshotFs = {
    realpath: async (filePath) => {
        try {
            return await realpathFn(filePath);
        }
        catch {
            throw new SnapshotReadError("resolve_failed");
        }
    },
    open: async (filePath, flags) => {
        try {
            const handle = await open(filePath, flags);
            return nodeSnapshotHandle(handle);
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string") {
                const code = error.code;
                if (code === "ELOOP" || code === "ENOENT" || code === "EACCES") {
                    throw new SnapshotReadError("open_failed");
                }
            }
            throw new SnapshotReadError("io_error");
        }
    },
    stat: async (filePath) => {
        try {
            const result = await stat(filePath, { bigint: true });
            return {
                isFile: () => result.isFile(),
                isSymbolicLink: () => result.isSymbolicLink(),
                dev: result.dev,
                ino: result.ino,
                size: result.size,
                mtimeMs: result.mtimeMs,
                nlink: result.nlink,
            };
        }
        catch {
            throw new SnapshotReadError("io_error");
        }
    },
};
/** Convert a Node `FileHandle` into the minimal {@link SnapshotHandle}. */
function nodeSnapshotHandle(handle) {
    return {
        fstat: async () => {
            try {
                const result = await handle.stat({ bigint: true });
                return {
                    isFile: () => result.isFile(),
                    isSymbolicLink: () => result.isSymbolicLink(),
                    dev: result.dev,
                    ino: result.ino,
                    size: result.size,
                    mtimeMs: result.mtimeMs,
                    nlink: result.nlink,
                };
            }
            catch {
                throw new SnapshotReadError("io_error");
            }
        },
        readBounded: async (maxBytes) => {
            const buffer = Buffer.alloc(maxBytes + 1);
            let offset = 0;
            while (offset < buffer.length) {
                try {
                    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
                    if (bytesRead === 0)
                        break;
                    offset += bytesRead;
                }
                catch {
                    throw new SnapshotReadError("io_error");
                }
            }
            if (offset > maxBytes)
                throw new SnapshotReadError("too_large");
            try {
                return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
            }
            catch {
                throw new SnapshotReadError("utf8_invalid");
            }
        },
        close: async () => {
            try {
                await handle.close();
            }
            catch {
                // Closing is best-effort; ignore raw errors at this seam.
            }
        },
    };
}
/**
 * Compare two snapshot stats for identity equality (dev, ino, size, mtime,
 * nlink). mtime and size are part of the identity because atomic same-path
 * same-inode replacement (rare but possible) would change mtime.
 */
function statsEqual(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.nlink === right.nlink);
}
/**
 * Read one bounded raw snapshot from an already-resolved vault path.
 *
 * The reader defends against symlink-swap-at-open and same-path replacement
 * by binding the open handle to the inode at the canonical target, then
 * re-statting the path and refusing any dev/ino/size/mtime drift. The
 * root identity check uses `VaultPaths.resolveRead` (which re-establishes
 * the current dev/ino of the vault root) both before and after the read so
 * a swapped vault root is also rejected. The handle is opened with
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` so an attacker who swaps the
 * canonical target after the open cannot redirect the handle to a new
 * inode.
 */
export async function readSnapshotFile(snapshotFs, vaultPaths, trustedRootReal, resolved, maxBytes) {
    await vaultPaths.resolveRead(resolved.vaultRelative, { automatic: false });
    const canonicalAbsolute = await snapshotFs.realpath(resolved.absolute);
    assertContainedSnapshotPath(trustedRootReal, canonicalAbsolute);
    const handle = await snapshotFs.open(canonicalAbsolute, SNAPSHOT_OPEN_FLAGS);
    try {
        const openedStat = await handle.fstat();
        if (!openedStat.isFile())
            throw new SnapshotReadError("not_file");
        if (openedStat.size < 0n)
            throw new SnapshotReadError("io_error");
        if (openedStat.size > BigInt(maxBytes)) {
            throw new SnapshotReadError("too_large");
        }
        await assertLogicalPathBound(snapshotFs, trustedRootReal, resolved.absolute, canonicalAbsolute, openedStat);
        let source;
        try {
            source = await handle.readBounded(maxBytes);
        }
        catch (error) {
            if (error instanceof SnapshotReadError)
                throw error;
            throw new SnapshotReadError("io_error");
        }
        if (source.includes("\u0000"))
            throw new SnapshotReadError("nul_byte");
        const afterStat = await handle.fstat();
        if (!statsEqual(openedStat, afterStat)) {
            throw new SnapshotReadError("instability_detected");
        }
        const finalResolved = await vaultPaths.resolveRead(resolved.vaultRelative, {
            automatic: false,
        });
        await assertLogicalPathBound(snapshotFs, trustedRootReal, finalResolved.absolute, canonicalAbsolute, afterStat);
        const finalStat = await handle.fstat();
        if (!statsEqual(afterStat, finalStat)) {
            throw new SnapshotReadError("instability_detected");
        }
        const vaultPath = parseWithSchema(VaultPathSchema, resolved.vaultRelative, "snapshot path");
        const modifiedAt = parseWithSchema(IsoTimestampSchema, new Date(Number(openedStat.mtimeMs)).toISOString(), "snapshot modified time");
        return { path: vaultPath, source, modified_at: modifiedAt };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
function assertContainedSnapshotPath(trustedRootReal, candidateReal) {
    const relative = path.relative(trustedRootReal, candidateReal);
    if (relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        throw new SnapshotReadError("swap_detected");
    }
}
async function assertLogicalPathBound(snapshotFs, trustedRootReal, logicalAbsolute, expectedCanonical, expectedStat) {
    const currentCanonical = await snapshotFs.realpath(logicalAbsolute);
    assertContainedSnapshotPath(trustedRootReal, currentCanonical);
    if (currentCanonical !== expectedCanonical) {
        throw new SnapshotReadError("swap_detected");
    }
    const currentStat = await snapshotFs.stat(currentCanonical);
    if (!currentStat.isFile() || !statsEqual(expectedStat, currentStat)) {
        throw new SnapshotReadError("swap_detected");
    }
}
