/** Agent-independent bounded lexical vault retrieval. */
import {
  chmod,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { extractSection, parseNote } from "./markdown.js";
import { VaultPathError, VaultPaths, type VaultPathsFs } from "./paths.js";
import { parseSearchHit } from "./schemas.js";
import type { SearchHit } from "./types.js";

export const MAX_NOTE_BYTES = 512 * 1024;
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_SEARCH_HITS = 32;
export const MAX_SNIPPET_CHARS = 8_000;
export const MAX_READ_CHARS = 100_000;

export type SearchErrorCode = "invalid_query" | "vault_unreadable";

const SEARCH_ERROR_MESSAGES: Record<SearchErrorCode, string> = {
  invalid_query: "search query is invalid",
  vault_unreadable: "vault search is unavailable",
};

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode) {
    super(SEARCH_ERROR_MESSAGES[code]);
    this.name = "SearchError";
    this.code = code;
  }
}

export interface SearchDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SearchStat {
  isDirectory(): boolean;
  isFile(): boolean;
  dev: bigint;
  ino: bigint;
  mtimeMs: bigint;
  size: bigint;
}

export interface SearchFs extends VaultPathsFs {
  stat(filePath: string): Promise<SearchStat>;
  lstat(filePath: string): Promise<SearchStat & { isSymbolicLink(): boolean }>;
  readdir(filePath: string): Promise<SearchDirent[]>;
  readFileBounded(filePath: string, maxBytes: number): Promise<string>;
}

async function readFileBounded(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new Error("bounded read overflow");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readDirectoryBounded(filePath: string): Promise<SearchDirent[]> {
  const handle = await opendir(filePath);
  const entries: SearchDirent[] = [];
  try {
    for await (const entry of handle) {
      if (entries.length >= 256) throw new Error("directory entry budget exceeded");
      entries.push(entry);
    }
    return entries;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const nodeSearchFs: SearchFs = {
  realpath,
  stat: (filePath) => stat(filePath, { bigint: true }),
  lstat: (filePath) => lstat(filePath, { bigint: true }),
  readdir: readDirectoryBounded,
  readFileBounded,
};

export interface SearchCacheStore {
  read(): Promise<unknown>;
  write(serialized: string): Promise<void>;
}

export interface NodeSearchCacheOptions {
  xdgStateHome?: string;
  home?: string;
  cacheName?: string;
}

/** Build the production cache store outside the vault with atomic replacement. */
export function nodeSearchCacheStore(
  options: NodeSearchCacheOptions = {},
): SearchCacheStore {
  const stateRoot = options.xdgStateHome ??
    path.join(options.home ?? os.homedir(), ".local", "state");
  const cacheDirectory = path.join(stateRoot, "resyst-vault", "cache");
  const cacheFile = path.join(cacheDirectory, options.cacheName ?? "lexical-index-v1.json");
  return {
    async read(): Promise<unknown> {
      try {
        const cacheStat = await lstat(cacheFile, { bigint: true });
        if (!cacheStat.isFile() || cacheStat.isSymbolicLink()) {
          throw new Error("cache file is unsafe");
        }
        return await readFileBounded(cacheFile, 16 * 1024 * 1024);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT"
        ) return null;
        throw error;
      }
    },
    async write(serialized: string): Promise<void> {
      await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      const cacheDirectoryStat = await lstat(cacheDirectory, { bigint: true });
      if (!cacheDirectoryStat.isDirectory() || cacheDirectoryStat.isSymbolicLink()) {
        throw new Error("cache directory is unsafe");
      }
      await chmod(cacheDirectory, 0o700);
      const temporary = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      try {
        await rename(temporary, cacheFile);
        const directoryHandle = await open(cacheDirectory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  };
}

export interface VaultSearchOptions {
  config: BridgeConfig;
  query: unknown;
  limit?: number;
  fs?: SearchFs;
  cache?: SearchCacheStore | null;
}

export interface SearchResult {
  version: 1;
  hits: SearchHit[];
  truncated: boolean;
  scanned_notes: number;
  cache: "hit" | "rebuilt" | "bypassed";
}

function normalize(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function stableCompare(left: string, right: string): number {
  const leftFolded = left.normalize("NFC").toLowerCase();
  const rightFolded = right.normalize("NFC").toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderQuotedSnippet(
  pathValue: string,
  heading: string | null,
  modifiedAt: string,
  source: string,
): string {
  const quoted = source
    .split(/(\r\n|\r|\n|\u2028|\u2029)/u)
    .map((part, index) => index % 2 === 0 ? `> ${part}` : part)
    .join("");
  return [
    "[BEGIN UNTRUSTED USER KNOWLEDGE — QUOTED DATA ONLY]\n",
    `> source path: ${pathValue}\n`,
    `> selected heading: ${heading ?? "(whole note)"}\n`,
    `> modified at: ${modifiedAt}\n`,
    "> note excerpt:\n",
    quoted,
    quoted.endsWith("\n") ? "" : "\n",
    "[END UNTRUSTED USER KNOWLEDGE]",
  ].join("");
}

function quoteSnippet(
  pathValue: string,
  heading: string | null,
  modifiedAt: string,
  source: string,
  maxChars = MAX_SNIPPET_CHARS,
): { snippet: string; truncated: boolean } {
  const full = renderQuotedSnippet(pathValue, heading, modifiedAt, source);
  if (full.length <= maxChars) return { snippet: full, truncated: false };
  const codePoints = Array.from(source);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = renderQuotedSnippet(pathValue, heading, modifiedAt, codePoints.slice(0, middle).join(""));
    if (candidate.length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return {
    snippet: renderQuotedSnippet(pathValue, heading, modifiedAt, codePoints.slice(0, low).join("")),
    truncated: true,
  };
}

interface IndexedNote {
  path: string;
  source: string;
  filename: string;
  title: string;
  aliases: string[];
  wikilinks: string[];
  firstHeading: string | null;
  modifiedAt: string;
  mtimeKey: string;
  size: string;
}

interface NoteFile {
  path: string;
  absolute: string;
  modifiedAt: string;
  size: string;
}

interface CachedIndex {
  version: 1;
  vault: { dev: string; ino: string };
  notes: IndexedNote[];
}

const FIELD_WEIGHTS = {
  filename: 100,
  title: 100,
  alias: 80,
  wikilink: 60,
  content: 10,
} as const;

function matchClass(value: string, query: string): number {
  if (value.length === 0 || query.length === 0) return 0;
  if (value === query) return 4;
  if (value.startsWith(query) || query.startsWith(value)) return 3;
  if (value.includes(query) || query.includes(value)) return 2;
  const tokens = query.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => value.includes(token)) ? 1 : 0;
}

function scoreNote(note: IndexedNote, query: string): {
  score: number;
  matchedOn: Array<keyof typeof FIELD_WEIGHTS>;
} {
  const fields: Array<{
    kind: keyof typeof FIELD_WEIGHTS;
    values: string[];
  }> = [
    { kind: "filename", values: [note.filename] },
    { kind: "title", values: [note.title] },
    { kind: "alias", values: note.aliases },
    { kind: "wikilink", values: note.wikilinks },
    { kind: "content", values: [note.source] },
  ];
  let score = 0;
  const matchedOn: Array<keyof typeof FIELD_WEIGHTS> = [];
  for (const field of fields) {
    const classification = Math.max(
      0,
      ...field.values.map((value) => matchClass(normalize(value), query)),
    );
    if (classification === 0) continue;
    matchedOn.push(field.kind);
    score += classification * FIELD_WEIGHTS[field.kind];
  }
  return { score, matchedOn };
}

function isBoundedStringArray(
  value: unknown,
  maxItems: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= 1_024)
  );
}

function parseCachedIndex(value: unknown): CachedIndex | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024 * 1024) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    const vault = candidate.vault;
    if (
      candidate.version !== 1 ||
      typeof vault !== "object" || vault === null || Array.isArray(vault) ||
      !Array.isArray(candidate.notes) || candidate.notes.length > 4_096
    ) return null;
    const vaultRecord = vault as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 3 || Object.keys(vaultRecord).length !== 2 ||
      typeof vaultRecord.dev !== "string" || !/^\d+$/u.test(vaultRecord.dev) ||
      typeof vaultRecord.ino !== "string" || !/^\d+$/u.test(vaultRecord.ino)
    ) return null;
    const notes: IndexedNote[] = [];
    for (const raw of candidate.notes) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
      const note = raw as Record<string, unknown>;
      if (
        Object.keys(note).length !== 10 ||
        typeof note.path !== "string" || note.path.length > 1_024 ||
        typeof note.source !== "string" ||
        Buffer.byteLength(note.source, "utf8") > MAX_NOTE_BYTES ||
        typeof note.filename !== "string" || note.filename.length > 1_024 ||
        typeof note.title !== "string" || note.title.length > 1_024 ||
        !isBoundedStringArray(note.aliases, 64) ||
        !isBoundedStringArray(note.wikilinks, 4_096) ||
        !(
          note.firstHeading === null ||
          (typeof note.firstHeading === "string" && note.firstHeading.length <= 512)
        ) ||
        typeof note.modifiedAt !== "string" ||
        !Number.isFinite(Date.parse(note.modifiedAt)) ||
        typeof note.mtimeKey !== "string" || !/^-?\d+$/u.test(note.mtimeKey) ||
        typeof note.size !== "string" || !/^\d+$/u.test(note.size)
      ) return null;
      notes.push({
        path: note.path,
        source: note.source,
        filename: note.filename,
        title: note.title,
        aliases: note.aliases,
        wikilinks: note.wikilinks,
        firstHeading: note.firstHeading,
        modifiedAt: note.modifiedAt,
        mtimeKey: note.mtimeKey,
        size: note.size,
      });
    }
    return {
      version: 1,
      vault: { dev: vaultRecord.dev, ino: vaultRecord.ino },
      notes,
    };
  } catch {
    return null;
  }
}

async function verifyTrustedRoot(
  config: BridgeConfig,
  fs: SearchFs,
): Promise<void> {
  const [real, current] = await Promise.all([
    fs.realpath(config.vault_path),
    fs.stat(config.vault_path),
  ]);
  if (
    !current.isDirectory() ||
    real !== config.vault_identity.real_path ||
    current.dev !== config.vault_identity.dev ||
    current.ino !== config.vault_identity.ino
  ) throw new Error("vault root identity changed");
}

async function listVaultNotes(
  options: VaultSearchOptions,
  fs: SearchFs,
  vaultPaths: VaultPaths,
): Promise<NoteFile[]> {
  const files: NoteFile[] = [];
  const pending: Array<{ relative: string; absolute: string; depth: number }> = [
    { relative: "", absolute: options.config.vault_path, depth: 0 },
  ];
  let visitedEntries = 0;
  let visitedDirectories = 0;
  let indexedBytes = 0n;
  while (pending.length > 0) {
    const directory = pending.shift();
    if (!directory) break;
    if (directory.depth > 16 || visitedDirectories >= 512) {
      throw new Error("directory scan budget exceeded");
    }
    visitedDirectories += 1;
    if (directory.relative.length === 0) await verifyTrustedRoot(options.config, fs);
    else await vaultPaths.resolveDirectory(directory.relative, { automatic: true });
    const entries = await fs.readdir(directory.absolute);
    if (directory.relative.length === 0) await verifyTrustedRoot(options.config, fs);
    else await vaultPaths.resolveDirectory(directory.relative, { automatic: true });
    entries.sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > 4_096) throw new Error("entry scan budget exceeded");
      const relative = directory.relative.length === 0
        ? entry.name
        : `${directory.relative}/${entry.name}`;
      if (entry.isSymbolicLink() && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (
          entry.name === ".resyst" ||
          entry.name === ".stfolder" ||
          entry.name === ".git" ||
          relative === options.config.layout.attachments_dir
        ) continue;
        const resolved = await vaultPaths.resolveDirectory(relative, { automatic: true });
        pending.push({ relative, absolute: resolved.absolute, depth: directory.depth + 1 });
        continue;
      }
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
      if (/\.sync-conflict-/iu.test(entry.name)) continue;
      let resolved: Awaited<ReturnType<VaultPaths["resolveRead"]>>;
      try {
        resolved = await vaultPaths.resolveRead(relative, { automatic: true });
      } catch (error) {
        if (
          entry.isSymbolicLink() &&
          error instanceof VaultPathError &&
          error.code === "target_not_file"
        ) continue;
        throw error;
      }
      const fileStat = await fs.stat(resolved.absolute);
      if (fileStat.size > BigInt(MAX_NOTE_BYTES)) {
        throw new Error("note byte budget exceeded");
      }
      indexedBytes += fileStat.size;
      if (indexedBytes > BigInt(MAX_INDEX_BYTES)) {
        throw new Error("index byte budget exceeded");
      }
      files.push({
        path: resolved.vaultRelative,
        absolute: resolved.absolute,
        modifiedAt: fileStat.mtimeMs.toString(),
        size: fileStat.size.toString(),
      });
      if (files.length > 4_096) throw new Error("note scan budget exceeded");
    }
  }
  files.sort((left, right) => stableCompare(left.path, right.path));
  return files;
}

function deriveIndexedNote(file: NoteFile, source: string): IndexedNote | null {
  if (source.includes("\u0000")) return null;
  if (Buffer.byteLength(source, "utf8") > MAX_NOTE_BYTES) {
    throw new Error("vault note exceeds byte budget");
  }
  const parsed = parseNote(source);
  if (parsed.frontmatter.kind === "invalid" || parsed.managed.kind !== "ok") {
    throw new Error("vault note is structurally invalid");
  }
  const filename = file.path.slice(file.path.lastIndexOf("/") + 1, -3);
  const firstHeading = parsed.headings[0]?.text ?? null;
  const metadata = parsed.frontmatter.kind === "present"
    ? parsed.frontmatter.metadata
    : null;
  const title = metadata?.title ?? firstHeading ?? filename;
  const wikilinks = parsed.wikilinks.flatMap((link) => [
    ...(link.target === null ? [] : [link.target]),
    ...(link.alias === null ? [] : [link.alias]),
  ]);
  if (
    title.length > 1_024 ||
    (firstHeading !== null && firstHeading.length > 512) ||
    wikilinks.length > 4_096 ||
    wikilinks.some((link) => link.length > 1_024)
  ) throw new Error("vault note metadata exceeds index budget");
  return {
    path: file.path,
    source,
    filename,
    title,
    aliases: metadata?.aliases ?? [],
    wikilinks,
    firstHeading,
    modifiedAt: new Date(Number(BigInt(file.modifiedAt))).toISOString(),
    mtimeKey: file.modifiedAt,
    size: file.size,
  };
}

function cachedNoteIsValid(note: IndexedNote): boolean {
  try {
    const derived = deriveIndexedNote(
      {
        path: note.path,
        absolute: "",
        modifiedAt: note.mtimeKey,
        size: note.size,
      },
      note.source,
    );
    return derived !== null && JSON.stringify(derived) === JSON.stringify(note);
  } catch {
    return false;
  }
}

async function indexNote(
  file: NoteFile,
  fs: SearchFs,
  vaultPaths: VaultPaths,
): Promise<IndexedNote | null> {
  const resolved = await vaultPaths.resolveRead(file.path, { automatic: true });
  const before = await fs.stat(resolved.absolute);
  if (
    before.mtimeMs.toString() !== file.modifiedAt ||
    before.size.toString() !== file.size ||
    !before.isFile()
  ) throw new Error("vault note changed during indexing");
  const source = await fs.readFileBounded(resolved.absolute, MAX_NOTE_BYTES);
  const after = await fs.stat(resolved.absolute);
  if (
    after.dev !== before.dev || after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs || after.size !== before.size ||
    !after.isFile()
  ) throw new Error("vault note changed during indexing");
  return deriveIndexedNote(file, source);
}

async function loadIndex(
  options: VaultSearchOptions,
  fs: SearchFs,
  vaultPaths: VaultPaths,
  cache: SearchCacheStore | null,
): Promise<{ notes: IndexedNote[]; status: SearchResult["cache"] }> {
  const files = await listVaultNotes(options, fs, vaultPaths);
  let cached: CachedIndex | null = null;
  if (cache !== null) {
    try {
      cached = parseCachedIndex(await cache.read());
    } catch {
      cached = null;
    }
  }
  const identity = {
    dev: options.config.vault_identity.dev.toString(),
    ino: options.config.vault_identity.ino.toString(),
  };
  if (cached?.vault.dev !== identity.dev || cached.vault.ino !== identity.ino) cached = null;
  const cachedByPath = new Map((cached?.notes ?? []).map((note) => [note.path, note]));
  const notes: IndexedNote[] = [];
  let rebuilt = cached === null || (cached?.notes.length ?? 0) !== files.length;
  for (const file of files) {
    const prior = cachedByPath.get(file.path);
    if (
      prior !== undefined &&
      prior.mtimeKey === file.modifiedAt &&
      prior.size === file.size &&
      cachedNoteIsValid(prior)
    ) {
      notes.push(prior);
      continue;
    }
    rebuilt = true;
    const indexed = await indexNote(file, fs, vaultPaths);
    if (indexed !== null) notes.push(indexed);
  }
  if (cache === null) return { notes, status: "bypassed" };
  if (!rebuilt) return { notes, status: "hit" };
  const serialized = JSON.stringify({ version: 1, vault: identity, notes });
  try {
    if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) {
      return { notes, status: "bypassed" };
    }
    await cache.write(serialized);
    return { notes, status: "rebuilt" };
  } catch {
    return { notes, status: "bypassed" };
  }
}

function relevantExcerpt(
  note: IndexedNote,
  query: string,
): { source: string; heading: string | null } {
  let searchOffset = 0;
  for (const line of note.source.split(/\r\n|\r|\n|\u2028|\u2029/u)) {
    const lineStart = note.source.indexOf(line, searchOffset);
    if (lineStart < 0) break;
    const normalized = normalize(line);
    if (matchClass(normalized, query) > 0) {
      const parsed = parseNote(note.source);
      let heading: string | null = null;
      for (const occurrence of parsed.headings) {
        if (occurrence.start > lineStart) break;
        heading = occurrence.text;
      }
      return { source: line, heading };
    }
    searchOffset = lineStart + line.length;
    while (
      searchOffset < note.source.length &&
      /[\r\n\u2028\u2029]/u.test(note.source[searchOffset] ?? "")
    ) searchOffset += 1;
  }
  const first = note.source.split(/\r\n|\r|\n|\u2028|\u2029/u).find((line) => line.trim().length > 0) ?? "";
  return { source: first, heading: note.firstHeading };
}

/** Search vault Markdown through the typed public service seam. */
export async function searchVault(options: VaultSearchOptions): Promise<SearchResult> {
  if (typeof options.query !== "string") throw new SearchError("invalid_query");
  const query = normalize(options.query);
  if (query.length === 0 || query.length > 256) throw new SearchError("invalid_query");
  const fs = options.fs ?? nodeSearchFs;
  const vaultPaths = new VaultPaths(options.config.vault_path, {
    identity: options.config.vault_identity,
    attachmentsDir: options.config.layout.attachments_dir,
    fs,
  });
  let notes: IndexedNote[];
  let cacheStatus: SearchResult["cache"];
  const cache = options.cache === undefined ? nodeSearchCacheStore() : options.cache;
  try {
    const loaded = await loadIndex(options, fs, vaultPaths, cache);
    notes = loaded.notes;
    cacheStatus = loaded.status;
  } catch {
    throw new SearchError("vault_unreadable");
  }
  const hits: SearchHit[] = [];
  for (const note of notes) {
    const scored = scoreNote(note, query);
    if (scored.score === 0) continue;
    const excerpt = relevantExcerpt(note, query);
    const rendered = quoteSnippet(note.path, excerpt.heading, note.modifiedAt, excerpt.source);
    hits.push(parseSearchHit({
      path: note.path,
      title: note.title,
      heading: excerpt.heading,
      modified_at: note.modifiedAt,
      snippet: rendered.snippet,
      snippet_truncated: rendered.truncated,
      matched_on: scored.matchedOn,
      score: scored.score,
    }));
  }
  hits.sort((left, right) => right.score - left.score || stableCompare(left.path, right.path));
  const requested = Number.isSafeInteger(options.limit) ? options.limit as number : MAX_SEARCH_HITS;
  const limit = Math.min(MAX_SEARCH_HITS, Math.max(1, requested));
  return {
    version: 1,
    hits: hits.slice(0, limit),
    truncated: hits.length > limit,
    scanned_notes: notes.length,
    cache: cacheStatus,
  };
}


export type VaultReadErrorCode =
  | "invalid_path"
  | "note_unreadable"
  | "invalid_heading"
  | "heading_missing"
  | "heading_ambiguous";

const READ_ERROR_MESSAGES: Record<VaultReadErrorCode, string> = {
  invalid_path: "vault read path is invalid",
  note_unreadable: "vault note is unavailable",
  invalid_heading: "vault heading is invalid",
  heading_missing: "vault heading is missing",
  heading_ambiguous: "vault heading is ambiguous",
};

export class VaultReadError extends Error {
  readonly code: VaultReadErrorCode;
  readonly count?: number;

  constructor(code: VaultReadErrorCode, count?: number) {
    super(READ_ERROR_MESSAGES[code]);
    this.name = "VaultReadError";
    this.code = code;
    if (count !== undefined) this.count = count;
  }
}

export interface VaultReadOptions {
  config: BridgeConfig;
  path: unknown;
  heading?: unknown;
  fs?: SearchFs;
}

export interface VaultReadResult {
  version: 1;
  path: import("./types.js").VaultPath;
  heading: string | null;
  modified_at: import("./types.js").IsoTimestamp;
  content: string;
  char_count: number;
  truncated: boolean;
}

/** Explicitly read one contained Markdown note or one exact heading section. */
export async function readVaultNote(options: VaultReadOptions): Promise<VaultReadResult> {
  if (typeof options.path !== "string") throw new VaultReadError("invalid_path");
  const fs = options.fs ?? nodeSearchFs;
  const vaultPaths = new VaultPaths(options.config.vault_path, {
    identity: options.config.vault_identity,
    attachmentsDir: options.config.layout.attachments_dir,
    fs,
  });
  let resolved: Awaited<ReturnType<VaultPaths["resolveRead"]>>;
  try {
    resolved = await vaultPaths.resolveRead(options.path, { automatic: false });
  } catch {
    throw new VaultReadError("invalid_path");
  }
  let source: string;
  let fileStat: SearchStat;
  try {
    const before = await fs.stat(resolved.absolute);
    source = await fs.readFileBounded(resolved.absolute, MAX_NOTE_BYTES);
    fileStat = await fs.stat(resolved.absolute);
    if (
      !before.isFile() || !fileStat.isFile() ||
      before.dev !== fileStat.dev || before.ino !== fileStat.ino ||
      before.mtimeMs !== fileStat.mtimeMs || before.size !== fileStat.size
    ) throw new Error("vault note changed during read");
  } catch {
    throw new VaultReadError("note_unreadable");
  }
  if (source.includes("\u0000")) throw new VaultReadError("note_unreadable");
  let selected = source;
  let heading: string | null = null;
  if (options.heading !== undefined) {
    if (typeof options.heading !== "string") throw new VaultReadError("invalid_heading");
    const extraction = extractSection(source, options.heading);
    if (extraction.kind === "invalid_heading") throw new VaultReadError("invalid_heading");
    if (extraction.kind === "missing") throw new VaultReadError("heading_missing");
    if (extraction.kind === "ambiguous") {
      throw new VaultReadError("heading_ambiguous", extraction.count);
    }
    selected = source.slice(extraction.section.body_start, extraction.section.section_end);
    heading = options.heading;
  }
  let modifiedAt: import("./types.js").IsoTimestamp;
  try {
    modifiedAt = new Date(Number(fileStat.mtimeMs)).toISOString() as import("./types.js").IsoTimestamp;
  } catch {
    throw new VaultReadError("note_unreadable");
  }
  const rendered = quoteSnippet(resolved.vaultRelative, heading, modifiedAt, selected, MAX_READ_CHARS);
  return {
    version: 1,
    path: resolved.vaultRelative,
    heading,
    modified_at: modifiedAt,
    content: rendered.snippet,
    char_count: Array.from(selected).length,
    truncated: rendered.truncated,
  };
}
