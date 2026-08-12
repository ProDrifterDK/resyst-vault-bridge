/**
 * Bounded read tool surface exposed to every Prime Agent runtime.
 *
 * The bridge never exposes the checkpoint tool here: write authority is
 * handled by a separate task. Service failures collapse to a single fixed
 * user-facing message; no caller-supplied data is echoed.
 */
import path from "node:path";
import {
  constants as fsConstants,
  open,
  realpath as realpathFn,
  stat,
} from "node:fs/promises";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BridgeConfig, ConfigFs } from "../config.js";
import { loadConfig } from "../config.js";
import {
  readVaultNote,
  searchVault,
  type SearchResult,
  type VaultReadResult,
  type SearchFs,
} from "../search.js";
import {
  VaultPathError,
  VaultPaths,
  type VaultPathsFs,
  nodeVaultPathsFs,
} from "../paths.js";
import {
  resolveProject,
  type ProjectFs,
  type GitRunner,
  type ProjectExecFile,
} from "../project.js";
import {
  type BootstrapNoteSnapshot,
  type BootstrapConfig,
  type BuildBootstrapInput,
  buildBootstrap,
} from "../bootstrap.js";
import {
  IsoTimestampSchema,
  VaultPathSchema,
  parseWithSchema,
} from "../schemas.js";
import type { ProjectResolution } from "../types.js";
import { VAULT_PATH_PATTERN } from "../schemas.js";

/** Fixed user-facing message returned for every tool failure. */
export const TOOL_UNAVAILABLE_MESSAGE = "vault tool unavailable";

/** Bootstrap input: the only field the adapter may pass is `cwd`. */
export interface BootstrapInput {
  cwd: string;
}

/** Search input forwarded to the underlying search service. */
export interface SearchInput {
  query: string;
  limit?: number;
}

/** Read input forwarded to the underlying read service. */
export interface ReadInput {
  path: string;
  heading?: string;
}

/** Stable, narrow read surface for the bridge; `bootstrap` carries no extras. */
export interface BridgeReadService {
  bootstrap(input: BootstrapInput): Promise<string>;
  search(input: SearchInput): Promise<SearchResult>;
  read(input: ReadInput): Promise<VaultReadResult>;
}

const MAX_QUERY_LENGTH = 256;
const MAX_LIMIT = 32;
const MIN_LIMIT = 1;
const MAX_PATH_LENGTH = 1024;
const MAX_HEADING_LENGTH = 512;

/**
 * TypeBox parameters for the search tool: bounded non-empty query plus an
 * optional bounded integer limit. Extra keys are rejected at the schema
 * boundary so callers cannot smuggle caller-supplied config or session.
 */
const SearchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    limit: Type.Optional(
      Type.Integer({ minimum: MIN_LIMIT, maximum: MAX_LIMIT }),
    ),
  },
  { additionalProperties: false },
);

/**
 * TypeBox parameters for the read tool: bounded vault-relative path (no
 * dot segments, no leading slash, no traversal, no backslashes) plus an
 * optional bounded heading string.
 */
const ReadParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: MAX_PATH_LENGTH,
      pattern: VAULT_PATH_PATTERN,
    }),
    heading: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_HEADING_LENGTH }),
    ),
  },
  { additionalProperties: false },
);

interface ToolDetails {
  version: 1;
  outcome: "ok" | "unavailable";
}

function successDetails(): ToolDetails {
  return { version: 1, outcome: "ok" };
}

function unavailableDetails(): ToolDetails {
  return { version: 1, outcome: "unavailable" };
}

function unavailableResult(): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text: TOOL_UNAVAILABLE_MESSAGE }],
    details: unavailableDetails(),
  };
}

function forwardSearch(
  service: BridgeReadService,
): (
  _callId: string,
  params: { query: string; limit?: number },
) => Promise<AgentToolResult<ToolDetails>> {
  return async (_callId, params) => {
    try {
      const forwarded: SearchInput = {
        query: params.query,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      };
      const result = await service.search(forwarded);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: successDetails(),
      };
    } catch {
      return unavailableResult();
    }
  };
}

function forwardRead(
  service: BridgeReadService,
): (
  _callId: string,
  params: { path: string; heading?: string },
) => Promise<AgentToolResult<ToolDetails>> {
  return async (_callId, params) => {
    try {
      const forwarded: ReadInput = {
        path: params.path,
        ...(params.heading === undefined ? {} : { heading: params.heading }),
      };
      const result = await service.read(forwarded);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: successDetails(),
      };
    } catch {
      return unavailableResult();
    }
  };
}

function searchToolDefinition(
  service: BridgeReadService,
): ToolDefinition<typeof SearchParameters, ToolDetails> {
  return {
    name: "vault_search",
    label: "Vault Search",
    description:
      "Search the configured Obsidian vault for notes matching the bounded query.",
    parameters: SearchParameters,
    execute: forwardSearch(service),
  };
}

function readToolDefinition(
  service: BridgeReadService,
): ToolDefinition<typeof ReadParameters, ToolDetails> {
  return {
    name: "vault_read",
    label: "Vault Read",
    description:
      "Read one bounded note or one exact heading section from the configured Obsidian vault.",
    parameters: ReadParameters,
    execute: forwardRead(service),
  };
}

/**
 * Register the bounded read tools synchronously. `vault_checkpoint` is
 * intentionally absent; only the search/read surface is exposed here.
 * The adapter never receives caller-supplied cwd/config/session through
 * any tool parameter.
 */
export function registerReadTools(
  api: ExtensionAPI,
  service: BridgeReadService,
): void {
  api.registerTool(searchToolDefinition(service));
  api.registerTool(readToolDefinition(service));
}

// ---------------------------------------------------------------------------
// Production bridge service with real lazy wiring.
// `loadConfig`, `searchVault`, `readVaultNote`, `resolveProject`, and
// `buildBootstrap` are the only authorities for vault data; the production
// service never invents results. All dependencies are injectable; the real
// vault is only touched at call time, never at import or registration.
// ---------------------------------------------------------------------------

/** Hard upper bound on raw snapshot bytes accepted by `readSnapshotFile`. */
const MAX_SNAPSHOT_BYTES = 1_000_000;

/** Estimated character budget per token; conservative 4 chars/token. */
const CHARS_PER_TOKEN = 4;

/** Stable path to the MOC index note; portable vault contract. */
const MOC_RELATIVE_PATH = "MOC — Inicio.md";

/** Stable path to the persistent identity note; portable vault contract. */
const CLAUDE_RELATIVE_PATH = "CLAUDE.md";

/** Stable path to the per-day daily note relative to the configured daily_dir. */
function dailyRelativePath(dailyDir: string, isoDate: string): string {
  return `${dailyDir}/${isoDate}.md`;
}

/** Default UTC date provider: ISO date `YYYY-MM-DD`. */
function defaultDateProvider(now: () => Date = () => new Date()): () => string {
  return () => now().toISOString().slice(0, 10);
}

/** Production dependencies used by the default service; all optional. */
export interface ProductionServiceDeps {
  configFs?: ConfigFs;
  searchFs?: SearchFs;
  projectFs?: ProjectFs;
  git?: GitRunner;
  execFile?: ProjectExecFile;
  /** Overrides the system clock for deterministic testing. */
  now?: () => Date;
  /** Overrides the XDG_CONFIG_HOME lookup. */
  xdgConfigHome?: string;
  /** Overrides the home directory lookup. */
  home?: string;
  /** Overrides the vault path containment seam. */
  vaultPathsFs?: VaultPathsFs;
  /** Overrides bounded snapshot reads/stat calls. */
  snapshotFs?: SnapshotFs;
}

/**
 * Build a complete `BridgeReadService` backed by the shared core. Returns
 * real results; failures surface as thrown errors that the adapter maps to
 * the fixed unavailable tool result.
 */
export function createProductionService(
  deps: ProductionServiceDeps = {},
): BridgeReadService {
  const dateProvider = defaultDateProvider(deps.now);
  const vaultPathsFs = deps.vaultPathsFs ?? nodeVaultPathsFs;
  const snapshotFs = deps.snapshotFs ?? nodeSnapshotFs;
  return {
    bootstrap: (input) =>
      bootstrapOnce(input, deps, dateProvider, vaultPathsFs, snapshotFs),
    search: (input) => searchOnce(input, deps),
    read: (input) => readOnce(input, deps),
  };
}

async function searchOnce(
  input: SearchInput,
  deps: ProductionServiceDeps,
): Promise<SearchResult> {
  const config = await loadOnce(deps);
  return await searchVault({
    config,
    query: input.query,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(deps.searchFs === undefined ? {} : { fs: deps.searchFs }),
  });
}

async function readOnce(
  input: ReadInput,
  deps: ProductionServiceDeps,
): Promise<VaultReadResult> {
  const config = await loadOnce(deps);
  return await readVaultNote({
    config,
    path: input.path,
    ...(input.heading === undefined ? {} : { heading: input.heading }),
    ...(deps.searchFs === undefined ? {} : { fs: deps.searchFs }),
  });
}

async function loadOnce(deps: ProductionServiceDeps): Promise<BridgeConfig> {
  return await loadConfig({
    ...(deps.configFs === undefined ? {} : { fs: deps.configFs }),
    ...(deps.home === undefined ? {} : { home: deps.home }),
    ...(deps.xdgConfigHome === undefined ? {} : { xdgConfigHome: deps.xdgConfigHome }),
  });
}

async function bootstrapOnce(
  input: BootstrapInput,
  deps: ProductionServiceDeps,
  dateProvider: () => string,
  vaultPathsFs: VaultPathsFs,
  snapshotStatFs: SnapshotFs,
): Promise<string> {
  const config = await loadOnce(deps);
  const project = await resolveProject({
    cwd: input.cwd,
    config,
    ...(deps.projectFs === undefined ? {} : { fs: deps.projectFs }),
    ...(deps.git === undefined ? {} : { git: deps.git }),
    ...(deps.execFile === undefined ? {} : { execFile: deps.execFile }),
  });
  const vaultPaths = new VaultPaths(config.vault_path, {
    identity: config.vault_identity,
    attachmentsDir: config.layout.attachments_dir,
    fs: vaultPathsFs,
  });
  const trustedRootReal = config.vault_identity.real_path;
  const claude = await readOptionalSnapshot(
    vaultPaths,
    snapshotStatFs,
    trustedRootReal,
    CLAUDE_RELATIVE_PATH,
  );
  const dailyPath = dailyRelativePath(config.layout.daily_dir, dateProvider());
  const currentDaily = await readOptionalSnapshot(
    vaultPaths,
    snapshotStatFs,
    trustedRootReal,
    dailyPath,
  );
  const moc = await readOptionalSnapshot(
    vaultPaths,
    snapshotStatFs,
    trustedRootReal,
    MOC_RELATIVE_PATH,
  );
  const projectNote = await readRequiredProjectSnapshot(
    vaultPaths,
    snapshotStatFs,
    trustedRootReal,
    project,
  );
  const bootstrapConfig: BootstrapConfig = {
    budget_tokens: config.budget.context_tokens,
    managed_headings: config.managed_headings,
  };
  const estimateTokens: (value: string) => number = (value) =>
    Math.ceil(Array.from(value).length / CHARS_PER_TOKEN);
  const buildInput: BuildBootstrapInput = {
    notes: {
      claude,
      current_daily: currentDaily,
      project: projectNote,
      moc,
    },
    project,
    config: bootstrapConfig,
    estimateTokens,
  };
  const result = buildBootstrap(buildInput);
  return result.context;
}

async function readOptionalSnapshot(
  vaultPaths: VaultPaths,
  snapshotStatFs: SnapshotFs,
  trustedRootReal: string,
  vaultRelative: string,
): Promise<BootstrapNoteSnapshot | null> {
  let resolved: { vaultRelative: string; absolute: string };
  try {
    resolved = await vaultPaths.resolveRead(vaultRelative, { automatic: false });
  } catch (error) {
    if (error instanceof VaultPathError && error.code === "target_missing") {
      return null;
    }
    throw error;
  }
  return await readSnapshotFile(
    snapshotStatFs,
    vaultPaths,
    trustedRootReal,
    resolved,
    MAX_SNAPSHOT_BYTES,
  );
}

async function readRequiredProjectSnapshot(
  vaultPaths: VaultPaths,
  snapshotStatFs: SnapshotFs,
  trustedRootReal: string,
  project: ProjectResolution,
): Promise<BootstrapNoteSnapshot | null> {
  if (project.kind !== "resolved") return null;
  if (project.note_path === null) return null;
  const resolved = await vaultPaths.resolveRead(project.note_path, { automatic: false });
  return await readSnapshotFile(
    snapshotStatFs,
    vaultPaths,
    trustedRootReal,
    resolved,
    MAX_SNAPSHOT_BYTES,
  );
}

/**
 * Snapshot reader status codes produced when the seam rejects an open, stat,
 * or read. Errors are redacted; the caller maps them to the fixed bootstrap
 * unavailable result so no path or content text ever leaves this boundary.
 */
export type SnapshotReadErrorCode =
  | "resolve_failed"
  | "open_failed"
  | "not_file"
  | "too_large"
  | "swap_detected"
  | "instability_detected"
  | "io_error"
  | "nul_byte"
  | "utf8_invalid";

/** Snapshot reader redacted error; fixed messages, no payload values. */
export class SnapshotReadError extends Error {
  readonly code: SnapshotReadErrorCode;
  constructor(code: SnapshotReadErrorCode) {
    super(`snapshot read failed: ${code}`);
    this.name = "SnapshotReadError";
    this.code = code;
  }
}

/** Lossless file identity shared by stat and fstat results. */
export interface SnapshotStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeMs: bigint;
  nlink: bigint;
}

/**
 * Open file handle bound to one inode. The handle is opened with caller
 * supplied flags and stays bound to the inode captured at `open`. The
 * handle owns a single `fstat` (lossless bigint identity), a bounded read
 * (`readBounded`) and a `close`. Operations must reject on any boundary
 * failure as the redacted {@link SnapshotReadError}; the production
 * adapter discards raw Node errors at this seam.
 */
export interface SnapshotHandle {
  fstat(): Promise<SnapshotStat>;
  readBounded(maxBytes: number): Promise<string>;
  close(): Promise<void>;
}

/**
 * Minimal filesystem seam used by the bootstrap snapshot reader. Every
 * method is precise and non-throwing across the supported boundary
 * failures: callers receive a {@link SnapshotReadError} for every expected
 * failure mode and the production adapter collapses raw Node errors to
 * `io_error`. All operations honor the conservative contracts the reader
 * relies on (bigint identity, fatal UTF-8 decoding, bounded reads).
 */
export interface SnapshotFs {
  /** Resolve an absolute path to its current canonical (realpath) form. */
  realpath(filePath: string): Promise<string>;
  /**
   * Open `filePath` with the supplied flags. The implementation must pass
   * the flags through to the kernel (no implicit following of symlinks);
   * `ELOOP` and `ENOENT` surface as `open_failed`.
   */
  open(filePath: string, flags: number): Promise<SnapshotHandle>;
  /** Stat the current path by name; lossless bigint identity. */
  stat(filePath: string): Promise<SnapshotStat>;
}

/**
 * Canonical open flags used by the snapshot reader. The combination rejects
 * every symlink at open time (`O_NOFOLLOW`), avoids blocking on FIFOs or
 * devices (`O_NONBLOCK` — only relevant when the path is a special file,
 * which is rejected immediately after `fstat`), and never requests write
 * access (`O_RDONLY`).
 */
export const SNAPSHOT_OPEN_FLAGS: number =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/**
 * Production adapter for {@link SnapshotFs} backed by `node:fs/promises`.
 * Raw Node errors are collapsed to {@link SnapshotReadError.io_error}; the
 * caller never sees an `ENOENT`, `ELOOP`, or `EACCES` text outside this
 * adapter.
 */
const nodeSnapshotFs: SnapshotFs = {
  realpath: async (filePath) => {
    try {
      return await realpathFn(filePath);
    } catch {
      throw new SnapshotReadError("resolve_failed");
    }
  },
  open: async (filePath, flags) => {
    try {
      const handle = await open(filePath, flags);
      return nodeSnapshotHandle(handle);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
      ) {
        const code = (error as { code: string }).code;
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
    } catch {
      throw new SnapshotReadError("io_error");
    }
  },
};

/** Convert a Node `FileHandle` into the minimal {@link SnapshotHandle}. */
function nodeSnapshotHandle(
  handle: import("node:fs/promises").FileHandle,
): SnapshotHandle {
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
      } catch {
        throw new SnapshotReadError("io_error");
      }
    },
    readBounded: async (maxBytes) => {
      const buffer = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        try {
          const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            null,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        } catch {
          throw new SnapshotReadError("io_error");
        }
      }
      if (offset > maxBytes) throw new SnapshotReadError("too_large");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, offset),
        );
      } catch {
        throw new SnapshotReadError("utf8_invalid");
      }
    },
    close: async () => {
      try {
        await handle.close();
      } catch {
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
function statsEqual(left: SnapshotStat, right: SnapshotStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.nlink === right.nlink
  );
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
async function readSnapshotFile(
  snapshotFs: SnapshotFs,
  vaultPaths: VaultPaths,
  trustedRootReal: string,
  resolved: { vaultRelative: string; absolute: string },
  maxBytes: number,
): Promise<BootstrapNoteSnapshot> {
  await vaultPaths.resolveRead(resolved.vaultRelative, { automatic: false });

  const canonicalAbsolute = await snapshotFs.realpath(resolved.absolute);
  assertContainedSnapshotPath(trustedRootReal, canonicalAbsolute);
  const handle = await snapshotFs.open(canonicalAbsolute, SNAPSHOT_OPEN_FLAGS);
  try {
    const openedStat = await handle.fstat();
    if (!openedStat.isFile()) throw new SnapshotReadError("not_file");
    if (openedStat.size < 0n) throw new SnapshotReadError("io_error");
    if (openedStat.size > BigInt(maxBytes)) {
      throw new SnapshotReadError("too_large");
    }

    await assertLogicalPathBound(
      snapshotFs,
      trustedRootReal,
      resolved.absolute,
      canonicalAbsolute,
      openedStat,
    );

    let source: string;
    try {
      source = await handle.readBounded(maxBytes);
    } catch (error) {
      if (error instanceof SnapshotReadError) throw error;
      throw new SnapshotReadError("io_error");
    }
    if (source.includes("\u0000")) throw new SnapshotReadError("nul_byte");

    const afterStat = await handle.fstat();
    if (!statsEqual(openedStat, afterStat)) {
      throw new SnapshotReadError("instability_detected");
    }

    const finalResolved = await vaultPaths.resolveRead(resolved.vaultRelative, {
      automatic: false,
    });
    await assertLogicalPathBound(
      snapshotFs,
      trustedRootReal,
      finalResolved.absolute,
      canonicalAbsolute,
      afterStat,
    );
    const finalStat = await handle.fstat();
    if (!statsEqual(afterStat, finalStat)) {
      throw new SnapshotReadError("instability_detected");
    }

    const vaultPath = parseWithSchema(
      VaultPathSchema,
      resolved.vaultRelative,
      "snapshot path",
    );
    const modifiedAt = parseWithSchema(
      IsoTimestampSchema,
      new Date(Number(openedStat.mtimeMs)).toISOString(),
      "snapshot modified time",
    );
    return { path: vaultPath, source, modified_at: modifiedAt };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertContainedSnapshotPath(
  trustedRootReal: string,
  candidateReal: string,
): void {
  const relative = path.relative(trustedRootReal, candidateReal);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new SnapshotReadError("swap_detected");
  }
}

async function assertLogicalPathBound(
  snapshotFs: SnapshotFs,
  trustedRootReal: string,
  logicalAbsolute: string,
  expectedCanonical: string,
  expectedStat: SnapshotStat,
): Promise<void> {
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
