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
import type { VaultPath } from "./types.js";

/** Default Obsidian attachments directory name. */
export const DEFAULT_ATTACHMENTS_DIR = "_adjuntos";

/** Required Markdown suffix for every note path accepted by VaultPaths. */
export const MARKDOWN_SUFFIX = ".md";

/** Stable error codes produced by the path boundary. */
export type VaultPathErrorCode =
  | "empty"
  | "not_relative"
  | "traversal"
  | "malformed"
  | "not_markdown"
  | "reserved"
  | "attachments_automatic"
  | "symlink_escape"
  | "symlink_target"
  | "target_missing"
  | "target_not_file"
  | "target_is_directory"
  | "parent_missing"
  | "parent_not_directory"
  | "io_error";

/** Fixed, redacted messages keyed by {@link VaultPathErrorCode}. */
const VAULT_PATH_ERROR_MESSAGES: Record<VaultPathErrorCode, string> = {
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
  readonly code: VaultPathErrorCode;

  constructor(code: VaultPathErrorCode) {
    super(VAULT_PATH_ERROR_MESSAGES[code]);
    this.name = "VaultPathError";
    this.code = code;
  }
}

/**
 * Minimal filesystem seam so tests never touch the real vault. `stat`/`lstat`
 * must expose the filesystem identity (`dev`/`ino`) so the vault root can be
 * pinned and re-verified on every resolve (Node `Stats` provides both on
 * POSIX with Node >= 22).
 */
export interface VaultPathsFs {
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<StatLike>;
  lstat(filePath: string): Promise<LStatLike>;
}

/** Node `fs/promises` adapter for {@link VaultPathsFs}. */
export const nodeVaultPathsFs: VaultPathsFs = {
  realpath,
  stat,
  lstat,
};

/**
 * Result of a successful containment check: branded path plus absolute path.
 *
 * This is a validation snapshot, not an authorization token: the filesystem
 * can change between this check and the final I/O (symlink swap, target
 * replacement), so callers must revalidate path/hash/structure at the final
 * I/O seam. The transaction service (Task 8) performs that revalidation
 * under the local lock before any write.
 */
export interface ResolvedVaultPath {
  vaultRelative: VaultPath;
  absolute: string;
}

/** Options for {@link VaultPaths.resolveRead}. */
export interface ReadOptions {
  /**
   * Automatic reads (bootstrap/search indexing) exclude the attachments
   * directory; explicit user reads are allowed. Defaults to `false`.
   */
  automatic?: boolean;
}

const RESERVED_SEGMENTS = new Set([".resyst", ".stfolder", ".git"]);

/**
 * Lexically validate a vault-relative POSIX Markdown path and return its
 * normalized segments, or throw a redacted {@link VaultPathError}. Runs
 * before any filesystem access.
 */
function lexicalSegments(
  input: unknown,
  automatic: boolean,
  attachmentsDir: string,
): string[] {
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
 * The containment boundary shared by every read and write path. Construct
 * with the configured vault root (already validated by the config layer).
 * The root's real path plus dev/ino identity is pinned on first use and
 * re-established on every resolve; a retargeted symlink, renamed-away root,
 * or same-pathname replacement is rejected as `symlink_escape` (or
 * `io_error` when the current identity cannot be established). Every
 * resolved note must stay inside the pinned real root.
 */
/** Pinned vault root identity: the initially resolved real path plus dev/ino. */
interface RootIdentity {
  real: string;
  dev: number;
  ino: number;
}

export class VaultPaths {
  readonly vaultRoot: string;
  readonly attachmentsDir: string;
  private readonly fs: VaultPathsFs;
  /** Initially pinned root identity; re-verified on every resolve. */
  private pinnedIdentity: RootIdentity | undefined;

  constructor(
    vaultRoot: string,
    options: { attachmentsDir?: string; fs?: VaultPathsFs } = {},
  ) {
    this.vaultRoot = vaultRoot;
    this.attachmentsDir = options.attachmentsDir ?? DEFAULT_ATTACHMENTS_DIR;
    this.fs = options.fs ?? nodeVaultPathsFs;
  }

  /**
   * Establish the CURRENT root identity: realpath plus dev/ino of the
   * configured root. Failures to establish identity (vanished root, EACCES,
   * EIO) surface as the fixed redacted `io_error`; a root that is no longer a
   * directory cannot establish the vault identity.
   */
  private async currentRootIdentity(): Promise<RootIdentity> {
    let real: string;
    try {
      real = await this.fs.realpath(this.vaultRoot);
    } catch {
      throw new VaultPathError("io_error");
    }
    let rootStat: StatLike;
    try {
      rootStat = await this.fs.stat(this.vaultRoot);
    } catch {
      throw new VaultPathError("io_error");
    }
    if (!rootStat.isDirectory()) {
      throw new VaultPathError("symlink_escape");
    }
    return { real, dev: rootStat.dev, ino: rootStat.ino };
  }

  /**
   * Re-establish the current root identity on every resolve and compare it to
   * the initially pinned identity. A retargeted symlink, renamed-away root,
   * or same-pathname replacement changes the realpath or the dev/ino and is
   * rejected with `symlink_escape`; the replacement is never blessed as the
   * new trusted root.
   */
  private async verifiedVaultReal(): Promise<string> {
    if (this.pinnedIdentity === undefined) {
      this.pinnedIdentity = await this.currentRootIdentity();
      return this.pinnedIdentity.real;
    }
    const current = await this.currentRootIdentity();
    if (
      current.real !== this.pinnedIdentity.real ||
      current.dev !== this.pinnedIdentity.dev ||
      current.ino !== this.pinnedIdentity.ino
    ) {
      throw new VaultPathError("symlink_escape");
    }
    return this.pinnedIdentity.real;
  }

  private isWithin(realPath: string, vaultReal: string): boolean {
    return realPath === vaultReal || realPath.startsWith(`${vaultReal}/`);
  }

  /** Resolve a note for reading; the target must exist and stay contained. */
  async resolveRead(input: string, options: ReadOptions = {}): Promise<ResolvedVaultPath> {
    const segments = lexicalSegments(
      input,
      options.automatic ?? false,
      this.attachmentsDir,
    );
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
    return { vaultRelative: input as VaultPath, absolute };
  }

  /** Resolve a note for writing; the parent must exist, the target must not be a symlink. */
  async resolveWrite(input: string): Promise<ResolvedVaultPath> {
    const segments = lexicalSegments(input, false, this.attachmentsDir);
    const vaultReal = await this.verifiedVaultReal();
    const absolute = path.join(this.vaultRoot, ...segments);

    // Every write validates its current parent — including root-level writes,
    // whose parent is the (re-verified) vault root itself.
    const parentSegments = segments.slice(0, -1);
    const parentAbs =
      parentSegments.length === 0
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

    let linkStat: LStatLike | null;
    try {
      linkStat = await this.fs.lstat(absolute);
    } catch (error) {
      if (errorIsCode(error, "ENOENT")) {
        // New file under a validated existing parent.
        return { vaultRelative: input as VaultPath, absolute };
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
    return { vaultRelative: input as VaultPath, absolute };
  }

  /**
   * Resolve the real path of an existing path. Only `ENOENT` maps to the
   * supplied absence code; every other failure becomes the fixed redacted
   * {@link VaultPathErrorCode.io_error} so no raw Node error or path leaks.
   */
  private async realpathOrThrow(
    filePath: string,
    absentCode: "target_missing" | "parent_missing",
  ): Promise<string> {
    try {
      return await this.fs.realpath(filePath);
    } catch (error) {
      if (errorIsCode(error, "ENOENT")) {
        throw new VaultPathError(absentCode);
      }
      throw new VaultPathError("io_error");
    }
  }

  /** lstat wrapper with the same ENOENT/io_error mapping as realpath. */
  private async lstatOrThrow(
    filePath: string,
    absentCode: "target_missing" | "parent_missing",
  ): Promise<LStatLike> {
    try {
      return await this.fs.lstat(filePath);
    } catch (error) {
      if (errorIsCode(error, "ENOENT")) {
        throw new VaultPathError(absentCode);
      }
      throw new VaultPathError("io_error");
    }
  }

  /** stat wrapper with the same ENOENT/io_error mapping as realpath. */
  private async statOrThrow(
    filePath: string,
    absentCode: "target_missing" | "parent_missing",
  ): Promise<StatLike> {
    try {
      return await this.fs.stat(filePath);
    } catch (error) {
      if (errorIsCode(error, "ENOENT")) {
        throw new VaultPathError(absentCode);
      }
      throw new VaultPathError("io_error");
    }
  }
}

/** Directory/file shape plus filesystem identity shared by stat results. */
interface StatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  dev: number;
  ino: number;
}

/** lstat result shape that additionally distinguishes symlinks. */
interface LStatLike extends StatLike {
  isSymbolicLink(): boolean;
}

/** Narrow a thrown `unknown` to its Node error code, if any. */
function errorIsCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
