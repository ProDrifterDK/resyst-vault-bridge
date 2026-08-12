/**
 * Deterministic project resolution (Task 4).
 *
 * This module is deliberately independent from both a vault Git repository and
 * a shell. Git is observed through an injected runner; filesystem reads are
 * observed through an injected, bounded project-filesystem seam. Resolution
 * never guesses: lexical candidates are returned as proposal data, never as a
 * selected project.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import {
  type NoteMetadata,
  type ParsedNote,
  parseNote,
} from "./markdown.js";
import type {
  IsoTimestamp,
  ProjectId,
  ProjectResolution,
  VaultPath,
} from "./types.js";

/** Maximum bytes accepted from either stdout or stderr of one Git command. */
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
/** Maximum time allowed for the injected Git command. */
export const GIT_TIMEOUT_MS = 5_000;
/** Maximum number of project notes inspected in deterministic path order. */
export const MAX_PROJECT_NOTES = 512;
/** Maximum UTF-8 bytes accepted for one project note. */
export const MAX_NOTE_BYTES = 512 * 1024;
/** Maximum number of lexical candidates exposed to association proposals. */
export const MAX_LEXICAL_CANDIDATES = 8;
/** Maximum normalized repositories retained from one Git listing. */
export const MAX_REMOTES = 32;
/** Maximum project-note directory depth below the configured projects dir. */
export const MAX_SCAN_DEPTH = 16;

/** Stable metadata extracted from one supported remote spelling. */
export interface NormalizedRemote {
  /** Canonical host/owner/name form, with no credentials or URL suffixes. */
  repo: string;
  host: string;
  owner: string;
  name: string;
}

/** Minimal Dirent shape needed by the bounded project scanner. */
export interface ProjectDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Filesystem seam used by resolution; tests can supply a fully synthetic FS. */
export interface ProjectFs {
  readFile(filePath: string): Promise<string>;
  readdir(filePath: string): Promise<ProjectDirent[]>;
  realpath(filePath: string): Promise<string>;
}

/** Node adapter for {@link ProjectFs}; no vault path is captured globally. */
export const nodeProjectFs: ProjectFs = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  readdir: (filePath) => readdir(filePath, { withFileTypes: true }),
  realpath,
};

/** Result returned by an injected Git runner. */
export type GitCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false };

/** Shell-free Git command seam. `args` excludes the injected `-C cwd`. */
export type GitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

/** Bounded options supplied to an injected `execFile` implementation. */
export interface ProjectExecFileOptions {
  encoding: "utf8";
  maxBuffer: number;
  timeout: number;
  killSignal: "SIGTERM";
  shell: false;
  windowsHide: true;
}

/** Promise-shaped, shell-free `execFile` seam for deterministic tests. */
export type ProjectExecFile = (
  file: string,
  args: readonly string[],
  options: ProjectExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

/** Node `execFile` adapter; every failure is intentionally redacted. */
const nodeProjectExecFile: ProjectExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Build a Git runner around the shell-free execFile seam. The full argv is
 * always `git -C <cwd> ...`; shell execution is explicitly disabled.
 */
export function makeGitRunner(execFile: ProjectExecFile): GitRunner {
  return async (args, options) => {
    try {
      const result = await execFile("git", ["-C", options.cwd, ...args], {
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGTERM",
        shell: false,
        windowsHide: true,
      });
      if (
        Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
        Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
      ) {
        return { ok: false };
      }
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch {
      return { ok: false };
    }
  };
}

/** Default bounded, shell-free Git runner used outside tests. */
export const nodeGitRunner: GitRunner = makeGitRunner(nodeProjectExecFile);

/** Dependencies and trusted configuration for one project-resolution request. */
export interface ResolveProjectOptions {
  /** Absolute agent working directory whose Git remotes are inspected. */
  cwd: string;
  /** Configuration already validated by `loadConfig`. */
  config: BridgeConfig;
  /** Synthetic or production filesystem seam. */
  fs?: ProjectFs;
  /** Higher-level Git seam; when omitted, `execFile`/node Git is used. */
  git?: GitRunner;
  /** Optional shell-free execFile seam used when `git` is omitted. */
  execFile?: ProjectExecFile;
}

/** One vault-relative lexical candidate; it is never an automatic selection. */
export interface LexicalCandidate {
  path: VaultPath;
}

/** Resolution plus bounded candidates retained for a future association proposal. */
export interface ProjectResolutionOutcome {
  resolution: ProjectResolution;
  lexical_candidates: LexicalCandidate[];
}

/** Data-only association proposal; this function never writes it. */
export interface AssociationProposal {
  version: 1;
  kind: "association";
  resolution: Exclude<ProjectResolution, { kind: "resolved" }>;
  candidates: VaultPath[];
  /** Unresolved association may write only to the daily note. */
  daily_write_only: true;
  created_at: IsoTimestamp;
}

/** Fixed, redacted invalid remote result: callers receive `null`, not details. */
export function normalizeRemote(input: string): NormalizedRemote | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 4096 ||
    /[\u0000-\u001F\u007F\\]/.test(trimmed)
  ) {
    return null;
  }

  // Queries and fragments are transport details, never repository identity.
  const query = trimmed.search(/[?#]/);
  const withoutSuffix = query >= 0 ? trimmed.slice(0, query) : trimmed;
  const parts = parseRemoteParts(withoutSuffix);
  if (!parts) return null;
  const host = parts.host.normalize("NFC").toLowerCase();
  const owner = parts.owner.normalize("NFC");
  const name = parts.name.normalize("NFC");
  if (!isRemotePart(host) || !isRemotePart(owner) || !isRemotePart(name)) {
    return null;
  }
  return {
    repo: `${host}/${owner}/${name}`,
    host,
    owner,
    name,
  };
}

/** Parse `git remote -v` output, deduping fetch/push and sorting stably. */
export function parseRemoteV(stdout: string): NormalizedRemote[] {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > MAX_GIT_OUTPUT_BYTES
  ) {
    return [];
  }
  const byKey = new Map<string, NormalizedRemote>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*\S+\s+(\S+)\s+\((?:fetch|push)\)\s*$/.exec(line);
    if (!match) continue;
    const remote = normalizeRemote(match[1] ?? "");
    if (!remote) continue;
    const key = remoteKey(remote.repo);
    if (!byKey.has(key)) byKey.set(key, remote);
  }
  return [...byKey.values()]
    .sort((left, right) => stableCompare(left.repo, right.repo))
    .slice(0, MAX_REMOTES);
}

/** Resolve one project and retain lexical evidence for a future proposal. */
export async function resolveProjectWithCandidates(
  options: ResolveProjectOptions,
): Promise<ProjectResolutionOutcome> {
  const fs = options.fs ?? nodeProjectFs;
  const git = options.git ?? makeGitRunner(options.execFile ?? nodeProjectExecFile);
  const gitState = await inspectGit(options.cwd, git);
  const scanned = await scanProjectNotes(options.config, fs);
  if (scanned.kind === "unreadable") {
    return {
      resolution: { kind: "unresolved", reason: "unreadable" },
      lexical_candidates: [],
    };
  }

  const notes = scanned.notes;
  const query = normalizeMatch(path.basename(trimTrailingSeparators(options.cwd)));

  // Tier 1: a normalized remote is the strongest identity signal.
  const remoteKeys = new Set(gitState.remotes.map((remote) => remoteKey(remote.repo)));
  if (remoteKeys.size > 0) {
    const remoteMatches = notes.filter((note) =>
      note.repositories.some((repo) => remoteKeys.has(repo)),
    );
    const selected = selectNotes(remoteMatches, "remote");
    if (selected) {
      return { resolution: selected, lexical_candidates: [] };
    }
  }

  // Tier 2: explicit portable id or portable alias.
  const portableIdMatches = notes.filter(
    (note) => note.portableId !== null && normalizeMatch(note.portableId) === query,
  );
  const portableAliasMatches = notes.filter((note) =>
    note.portableAliases.some((alias) => normalizeMatch(alias) === query),
  );
  const portableMatches = dedupeNotes([...portableIdMatches, ...portableAliasMatches]);
  if (portableMatches.length > 0) {
    const basis =
      portableMatches.length === 1 && portableIdMatches.includes(portableMatches[0]!)
        ? "portable_id"
        : portableMatches.length === 1 && portableAliasMatches.includes(portableMatches[0]!)
          ? "alias"
          : null;
    const selected = selectNotes(portableMatches, basis ?? "portable_id");
    if (selected) {
      return { resolution: selected, lexical_candidates: [] };
    }
  }

  // Tier 3: exact canonical local override. Prefixes never match.
  const override = await findExactOverrides(options.config, options.cwd, fs);
  if (override.length > 0) {
    const overrideIds = uniqueByKey(override, (id) => normalizeMatch(id));
    if (overrideIds.length === 1) {
      const id = overrideIds[0]!;
      const idMatches = notes.filter(
        (note) => note.projectId !== null && normalizeMatch(note.projectId) === normalizeMatch(id),
      );
      if (idMatches.length > 1) {
        return {
          resolution: ambiguous(idMatches),
          lexical_candidates: [],
        };
      }
      return {
        resolution: {
          kind: "resolved",
          project_id: id as ProjectId,
          basis: "local_override",
          note_path: idMatches.length === 1 ? idMatches[0]!.path : null,
        },
        lexical_candidates: [],
      };
    } else {
      const overrideNotes = notes.filter(
        (note) =>
          note.projectId !== null &&
          overrideIds.some((id) => normalizeMatch(id) === normalizeMatch(note.projectId ?? "")),
      );
      return {
        resolution: ambiguous(overrideNotes),
        lexical_candidates: [],
      };
    }
  }

  // Tier 4: exact directory, title, filename, or legacy note alias.
  const exactMatches = notes.filter((note) =>
    note.exactNames.some((name) => normalizeMatch(name) === query),
  );
  const exactSelection = selectNotes(exactMatches, "exact_name");
  if (exactSelection) {
    return { resolution: exactSelection, lexical_candidates: [] };
  }

  // Tier 5: lexical candidates are evidence for a future association only.
  const lexicalCandidates = rankLexicalCandidates(notes, query).map((note) => ({
    path: note.path,
  }));
  return {
    resolution: {
      kind: "unresolved",
      reason: gitState.state === "no_git" ? "no_git" : "no_match",
    },
    lexical_candidates: lexicalCandidates,
  };
}

/** Return the exact public ProjectResolution union (no wrapper fields). */
export async function resolveProject(
  options: ResolveProjectOptions,
): Promise<ProjectResolution> {
  return (await resolveProjectWithCandidates(options)).resolution;
}

/** Explicit name for callers that want the exact union contract. */
export const resolveProjectResolution = resolveProject;

/** Compatibility alias for adapters that call the identity operation directly. */
export const resolveProjectIdentity = resolveProject;

/** Build pure association data for unresolved/ambiguous resolution; never writes. */
export function buildAssociationProposal(
  outcome: ProjectResolutionOutcome | ProjectResolution,
  createdAt: IsoTimestamp,
  lexicalCandidates: readonly VaultPath[] = [],
): AssociationProposal | null {
  const resolution = "resolution" in outcome ? outcome.resolution : outcome;
  if (resolution.kind === "resolved") return null;
  const sourceCandidates =
    resolution.kind === "ambiguous"
      ? resolution.candidates
      : "resolution" in outcome
        ? outcome.lexical_candidates.map((candidate) => candidate.path)
        : lexicalCandidates;
  const deduped = uniqueByKey(
    sourceCandidates.filter(isVaultRelativeMarkdownPath),
    (candidate) => normalizePathKey(candidate),
  ).sort(stableCompare) as VaultPath[];
  const safeResolution: Exclude<ProjectResolution, { kind: "resolved" }> =
    resolution.kind === "ambiguous"
      ? { kind: "ambiguous", candidates: deduped }
      : { kind: "unresolved", reason: resolution.reason };
  return {
    version: 1,
    kind: "association",
    resolution: safeResolution,
    candidates: deduped,
    daily_write_only: true,
    created_at: createdAt,
  };
}

interface RemoteParts {
  host: string;
  owner: string;
  name: string;
}

function parseRemoteParts(value: string): RemoteParts | null {
  let host = "";
  let remotePath = "";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme) {
    const protocol = (scheme[1] ?? "").toLowerCase();
    if (protocol !== "https" && protocol !== "http" && protocol !== "ssh" && protocol !== "git") {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    host = parsed.hostname;
    remotePath = parsed.pathname;
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
    if (scp) {
      host = scp[1] ?? "";
      remotePath = scp[2] ?? "";
    } else {
      const slash = value.indexOf("/");
      if (slash <= 0) return null;
      host = value.slice(0, slash);
      remotePath = value.slice(slash + 1);
    }
  }
  remotePath = remotePath.replace(/^\/+|\/+$/g, "");
  if (remotePath.length === 0 || remotePath.includes("//")) return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(remotePath);
  } catch {
    return null;
  }
  const segments = decodedPath.split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  let name = segments[1] ?? "";
  if (/\.git$/i.test(name)) name = name.slice(0, -4);
  if (name.length === 0 || owner.length === 0) return null;
  if (!host.includes(".") && host !== "localhost") return null;
  return { host, owner, name };
}

function isRemotePart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\s\u0000-\u001F\u007F/:@?#]/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function remoteKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

interface ScannedProjectNote {
  path: VaultPath;
  portableId: ProjectId | null;
  projectId: ProjectId | null;
  portableAliases: string[];
  repositories: string[];
  exactNames: string[];
  lexicalNames: string[];
}

async function inspectGit(
  cwd: string,
  git: GitRunner,
): Promise<{ state: "no_git" | "available"; remotes: NormalizedRemote[] }> {
  if (
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    cwd.length > 4096 ||
    cwd.includes("\u0000")
  ) {
    return { state: "no_git", remotes: [] };
  }
  try {
    const result = await git(["remote", "-v"], { cwd });
    if (!result.ok) return { state: "no_git", remotes: [] };
    if (
      Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
    ) {
      return { state: "no_git", remotes: [] };
    }
    return { state: "available", remotes: parseRemoteV(result.stdout) };
  } catch {
    return { state: "no_git", remotes: [] };
  }
}

async function scanProjectNotes(
  config: BridgeConfig,
  fs: ProjectFs,
): Promise<{ kind: "ok"; notes: ScannedProjectNote[] } | { kind: "unreadable" }> {
  const root = path.resolve(config.vault_path, ...config.layout.projects_dir.split("/"));
  const seen = new Set<string>();
  const notes: ScannedProjectNote[] = [];
  try {
    await walkProjectDirectory(root, 0, config.vault_path, fs, seen, notes);
  } catch {
    return { kind: "unreadable" };
  }
  return { kind: "ok", notes };
}

async function walkProjectDirectory(
  directory: string,
  depth: number,
  vaultRoot: string,
  fs: ProjectFs,
  seen: Set<string>,
  notes: ScannedProjectNote[],
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || notes.length >= MAX_PROJECT_NOTES) return;
  const entries = await fs.readdir(directory);
  entries.sort((left, right) => stableCompare(left.name, right.name));
  for (const entry of entries) {
    if (notes.length >= MAX_PROJECT_NOTES) return;
    if (entry.name.length === 0 || entry.name === "." || entry.name === "..") continue;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkProjectDirectory(absolute, depth + 1, vaultRoot, fs, seen, notes);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const relative = toVaultRelative(vaultRoot, absolute);
    if (!relative || seen.has(normalizePathKey(relative))) continue;
    seen.add(normalizePathKey(relative));
    const source = await fs.readFile(absolute);
    if (Buffer.byteLength(source, "utf8") > MAX_NOTE_BYTES) continue;
    const note = parseProjectNote(source, relative, absolute);
    if (note) notes.push(note);
  }
}

function parseProjectNote(
  source: string,
  relative: VaultPath,
  absolute: string,
): ScannedProjectNote | null {
  try {
    const parsed: ParsedNote = parseNote(source);
    const metadata = parsed.frontmatter.kind === "present"
      ? parsed.frontmatter.metadata
      : emptyMetadata();
    const portable = metadata.resyst_project;
    const portableId = portable ? (portable.id as ProjectId) : null;
    const projectId = portableId ?? deriveProjectId(path.basename(relative, ".md"));
    const parent = path.basename(path.dirname(absolute));
    const filename = path.basename(relative, ".md");
    const firstH1 = parsed.headings.find((heading) => heading.level === 1)?.text ?? null;
    const exactNames = uniqueStrings([
      parent,
      filename,
      metadata.title ?? "",
      firstH1 ?? "",
      ...metadata.aliases,
    ]);
    const repositories = uniqueStrings(
      (portable?.repos ?? [])
        .map((repo) => normalizeRemote(repo))
        .filter((repo): repo is NormalizedRemote => repo !== null)
        .map((repo) => remoteKey(repo.repo)),
    );
    return {
      path: relative,
      portableId,
      projectId,
      portableAliases: portable?.aliases ?? [],
      repositories,
      exactNames,
      lexicalNames: uniqueStrings([
        ...exactNames,
        portable?.id ?? "",
        ...(portable?.aliases ?? []),
        ...(portable?.repos ?? []),
      ]),
    };
  } catch {
    // A malformed/unreadable note is handled by the caller's bounded scan.
    return null;
  }
}

function emptyMetadata(): NoteMetadata {
  return { title: null, date: null, tags: [], aliases: [], resyst_project: null };
}

function selectNotes(
  notes: ScannedProjectNote[],
  basis: "remote" | "portable_id" | "alias" | "exact_name",
): ProjectResolution | null {
  const unique = dedupeNotes(notes);
  if (unique.length === 0) return null;
  if (unique.length > 1) return ambiguous(unique);
  const note = unique[0]!;
  if (note.projectId === null) {
    return { kind: "unresolved", reason: "no_match" };
  }
  return {
    kind: "resolved",
    project_id: note.projectId,
    basis,
    note_path: note.path,
  };
}

function ambiguous(notes: ScannedProjectNote[]): ProjectResolution {
  return {
    kind: "ambiguous",
    candidates: dedupeNotes(notes).map((note) => note.path).sort(stableCompare),
  };
}

function dedupeNotes(notes: ScannedProjectNote[]): ScannedProjectNote[] {
  const byPath = new Map<string, ScannedProjectNote>();
  for (const note of notes) {
    const key = normalizePathKey(note.path);
    if (!byPath.has(key)) byPath.set(key, note);
  }
  return [...byPath.values()].sort((left, right) => stableCompare(left.path, right.path));
}

async function findExactOverrides(
  config: BridgeConfig,
  cwd: string,
  fs: ProjectFs,
): Promise<string[]> {
  if (config.project_overrides.length === 0) return [];
  let canonicalCwd: string;
  try {
    canonicalCwd = await fs.realpath(cwd);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const override of config.project_overrides) {
    try {
      const canonicalOverride = await fs.realpath(path.resolve(override.path));
      if (canonicalOverride === canonicalCwd) matches.push(override.project_id);
    } catch {
      // An override whose target disappeared is not an exact match.
    }
  }
  return matches;
}

function rankLexicalCandidates(
  notes: ScannedProjectNote[],
  query: string,
): ScannedProjectNote[] {
  const ranked: Array<{ note: ScannedProjectNote; score: number }> = [];
  for (const note of notes) {
    let best = Number.POSITIVE_INFINITY;
    for (const value of note.lexicalNames) {
      const candidate = normalizeMatch(value);
      if (candidate.length === 0 || query.length === 0) continue;
      if (candidate.startsWith(query) || query.startsWith(candidate)) {
        best = Math.min(best, 1);
      } else if (candidate.includes(query) || query.includes(candidate)) {
        best = Math.min(best, 2);
      } else {
        const queryTokens = query.split(" ").filter((token) => token.length > 0);
        if (queryTokens.some((token) => candidate.includes(token))) best = Math.min(best, 3);
      }
    }
    if (Number.isFinite(best)) ranked.push({ note, score: best });
  }
  return ranked
    .sort((left, right) => left.score - right.score || stableCompare(left.note.path, right.note.path))
    .slice(0, MAX_LEXICAL_CANDIDATES)
    .map((item) => item.note);
}

function deriveProjectId(stem: string): ProjectId | null {
  const normalized = stem.normalize("NFC");
  let value = "";
  let separator = false;
  for (const character of normalized) {
    if (/^[A-Za-z0-9]$/.test(character)) {
      value += character;
      separator = false;
    } else if (value.length > 0 && !separator) {
      value += "-";
      separator = true;
    }
    if (value.length >= 128) break;
  }
  value = value.replace(/-+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? (value as ProjectId)
    : null;
}

function normalizeMatch(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    const key = normalizeMatch(value);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueByKey<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function toVaultRelative(vaultRoot: string, absolute: string): VaultPath | null {
  const relative = path.relative(vaultRoot, absolute).split(path.sep).join("/");
  if (!isVaultRelativeMarkdownPath(relative)) return null;
  return relative as VaultPath;
}

function isVaultRelativeMarkdownPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    !value.endsWith(".md") ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function normalizePathKey(value: string): string {
  return value.normalize("NFC");
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

function stableCompare(left: string, right: string): number {
  const leftKey = left.normalize("NFC").toLowerCase();
  const rightKey = right.normalize("NFC").toLowerCase();
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
