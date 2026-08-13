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
import { lstat, opendir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { VaultPaths } from "./paths.js";
import { parseProjectResolution } from "./schemas.js";
import { parseNote, } from "./markdown.js";
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
/** Maximum entries visited across the entire deterministic scan. */
export const MAX_SCAN_ENTRIES = 4_096;
/** Maximum directories visited across the entire deterministic scan. */
export const MAX_SCAN_DIRECTORIES = 512;
/** Maximum entries materialized from one directory by the scanner seam. */
export const MAX_SCAN_ENTRIES_PER_DIRECTORY = 256;
/**
 * Node adapter for {@link ProjectFs}; no vault path is captured globally.
 * `opendir` keeps a hostile wide directory from being fully materialized
 * before the scanner can enforce its per-directory budget.
 */
async function nodeProjectReaddir(filePath) {
    const handle = await opendir(filePath);
    const entries = [];
    try {
        for await (const entry of handle) {
            if (entries.length >= MAX_SCAN_ENTRIES_PER_DIRECTORY) {
                throw new Error("project directory exceeds bounded entry budget");
            }
            entries.push(entry);
        }
        return entries;
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/**
 * Read a regular note with a hard byte ceiling. The buffer is exactly
 * `maxBytes + 1`, so a growing/replaced file cannot force an unbounded
 * allocation between validation and read; overflow is rejected before UTF-8
 * decoding/string materialization.
 */
async function nodeProjectReadFileBounded(filePath, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_NOTE_BYTES) {
        throw new Error("invalid bounded read limit");
    }
    const handle = await open(filePath, "r");
    try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const result = await handle.read(buffer, offset, buffer.length - offset, null);
            if (result.bytesRead === 0)
                break;
            offset += result.bytesRead;
        }
        if (offset > maxBytes) {
            throw new Error("bounded read overflow");
        }
        return buffer.subarray(0, offset).toString("utf8");
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
export const nodeProjectFs = {
    readFileBounded: nodeProjectReadFileBounded,
    readdir: nodeProjectReaddir,
    realpath,
    stat: (filePath) => stat(filePath, { bigint: true }),
    lstat: (filePath) => lstat(filePath, { bigint: true }),
};
/** Node `execFile` adapter; every failure is intentionally redacted. */
const nodeProjectExecFile = (file, args, options) => new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
        if (error) {
            reject(error);
            return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
});
/**
 * Build a Git runner around the shell-free execFile seam. The full argv is
 * always `git -C <cwd> ...`; shell execution is explicitly disabled.
 */
export function makeGitRunner(execFile) {
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
            if (Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
                Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES) {
                return { ok: false };
            }
            return { ok: true, stdout: result.stdout, stderr: result.stderr };
        }
        catch {
            return { ok: false };
        }
    };
}
/** Default bounded, shell-free Git runner used outside tests. */
export const nodeGitRunner = makeGitRunner(nodeProjectExecFile);
/** Fixed, redacted invalid remote result: callers receive `null`, not details. */
export function normalizeRemote(input) {
    if (typeof input !== "string")
        return null;
    const trimmed = input.trim();
    if (trimmed.length === 0 ||
        trimmed.length > 4096 ||
        /[\u0000-\u001F\u007F\\]/.test(trimmed)) {
        return null;
    }
    // Queries and fragments are transport details, never repository identity.
    const query = trimmed.search(/[?#]/);
    const withoutSuffix = query >= 0 ? trimmed.slice(0, query) : trimmed;
    const parts = parseRemoteParts(withoutSuffix);
    if (!parts)
        return null;
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
export function parseRemoteV(stdout) {
    if (typeof stdout !== "string" ||
        Buffer.byteLength(stdout, "utf8") > MAX_GIT_OUTPUT_BYTES) {
        return [];
    }
    const byKey = new Map();
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*\S+\s+(\S+)\s+\((?:fetch|push)\)\s*$/.exec(line);
        if (!match)
            continue;
        const remote = normalizeRemote(match[1] ?? "");
        if (!remote)
            continue;
        const key = remoteKey(remote.repo);
        if (!byKey.has(key))
            byKey.set(key, remote);
    }
    return [...byKey.values()]
        .sort((left, right) => stableCompare(left.repo, right.repo))
        .slice(0, MAX_REMOTES);
}
/** Resolve one project and retain lexical evidence for a future proposal. */
export async function resolveProjectWithCandidates(options) {
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
    const override = await findExactOverrides(options.config, options.cwd, fs);
    const overrideIds = uniqueByKey(override, (id) => id.normalize("NFC"));
    if (overrideIds.length > 1) {
        // Conflicting exact machine-local identities invalidate the request even
        // when a higher tier happens to offer a match; never expose ambiguous([]).
        return {
            resolution: { kind: "unresolved", reason: "unreadable" },
            lexical_candidates: [],
        };
    }
    // Tier 1: a normalized remote is the strongest identity signal.
    const remoteKeys = new Set(gitState.remotes.map((remote) => remoteKey(remote.repo)));
    if (remoteKeys.size > 0) {
        const remoteMatches = notes.filter((note) => note.repositories.some((repo) => remoteKeys.has(repo)));
        const selected = selectNotes(remoteMatches, "remote");
        if (selected) {
            return { resolution: selected, lexical_candidates: [] };
        }
    }
    // Tier 2: explicit portable id or portable alias.
    const portableIdMatches = notes.filter((note) => note.portableId !== null && normalizeMatch(note.portableId) === query);
    const portableAliasMatches = notes.filter((note) => note.portableAliases.some((alias) => normalizeMatch(alias) === query));
    const portableMatches = dedupeNotes([...portableIdMatches, ...portableAliasMatches]);
    if (portableMatches.length > 0) {
        const basis = portableMatches.length === 1 && portableIdMatches.includes(portableMatches[0])
            ? "portable_id"
            : portableMatches.length === 1 && portableAliasMatches.includes(portableMatches[0])
                ? "alias"
                : null;
        const selected = selectNotes(portableMatches, basis ?? "portable_id");
        if (selected) {
            return { resolution: selected, lexical_candidates: [] };
        }
    }
    // Tier 3: exact canonical local override. Prefixes never match.
    if (override.length > 0) {
        if (overrideIds.length === 1) {
            const id = overrideIds[0];
            const idMatches = notes.filter((note) => note.projectId !== null && normalizeMatch(note.projectId) === normalizeMatch(id));
            if (idMatches.length > 1) {
                return {
                    resolution: ambiguous(idMatches),
                    lexical_candidates: [],
                };
            }
            return {
                resolution: {
                    kind: "resolved",
                    project_id: id,
                    basis: "local_override",
                    note_path: idMatches.length === 1 ? idMatches[0].path : null,
                },
                lexical_candidates: [],
            };
        }
    }
    // Tier 4: exact directory, title, filename, or legacy note alias.
    const exactMatches = notes.filter((note) => note.exactNames.some((name) => normalizeMatch(name.value) === query));
    const exactSelection = selectExactNotes(exactMatches, query);
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
export async function resolveProject(options) {
    return (await resolveProjectWithCandidates(options)).resolution;
}
/** Explicit name for callers that want the exact union contract. */
export const resolveProjectResolution = resolveProject;
/** Compatibility alias for adapters that call the identity operation directly. */
export const resolveProjectIdentity = resolveProject;
/** Build pure association data for unresolved/ambiguous resolution; never writes. */
export function buildAssociationProposal(outcome, createdAt, lexicalCandidates = []) {
    try {
        if (!isIsoUtcTimestamp(createdAt))
            return null;
        const directCandidates = strictProposalCandidates(lexicalCandidates);
        if (directCandidates === null)
            return null;
        let rawResolution = outcome;
        let wrapperCandidates = null;
        if (isRecord(outcome) && Object.prototype.hasOwnProperty.call(outcome, "resolution")) {
            if (!hasExactKeys(outcome, ["resolution", "lexical_candidates"]))
                return null;
            rawResolution = outcome.resolution;
            const rawCandidates = outcome.lexical_candidates;
            if (!Array.isArray(rawCandidates) || rawCandidates.length > MAX_LEXICAL_CANDIDATES) {
                return null;
            }
            wrapperCandidates = strictWrapperCandidates(rawCandidates);
            if (wrapperCandidates === null)
                return null;
        }
        const narrowed = narrowProposalResolution(rawResolution);
        if (narrowed === null || narrowed.kind === "resolved")
            return null;
        const deduped = narrowed.kind === "ambiguous"
            ? narrowed.candidates
            : wrapperCandidates ?? directCandidates;
        const safeResolution = narrowed.kind === "ambiguous"
            ? { kind: "ambiguous", candidates: deduped }
            : { kind: "unresolved", reason: narrowed.reason };
        return {
            version: 1,
            kind: "association",
            resolution: safeResolution,
            candidates: deduped,
            daily_write_only: true,
            created_at: createdAt,
        };
    }
    catch {
        // This is a runtime boundary: getters, proxies, and malformed JS-shaped
        // payloads are all rejected without copying attacker-controlled values.
        return null;
    }
}
function narrowProposalResolution(value) {
    if (!isRecord(value) || typeof value.kind !== "string")
        return null;
    if (value.kind === "resolved") {
        // Even though resolved proposals are never emitted, validate the full
        // shared union before rejecting it so malformed resolved payloads cannot
        // influence control flow.
        try {
            return parseProjectResolution(value);
        }
        catch {
            return null;
        }
    }
    if (value.kind === "unresolved") {
        if (!hasExactKeys(value, ["kind", "reason"]) || !isUnresolvedReason(value.reason)) {
            return null;
        }
        try {
            return parseProjectResolution({ kind: "unresolved", reason: value.reason });
        }
        catch {
            return null;
        }
    }
    if (value.kind === "ambiguous") {
        if (!hasExactKeys(value, ["kind", "candidates"]) || !Array.isArray(value.candidates)) {
            return null;
        }
        if (value.candidates.length > MAX_LEXICAL_CANDIDATES)
            return null;
        const candidates = strictProposalCandidates(value.candidates);
        if (candidates === null || candidates.length < 2)
            return null;
        try {
            return parseProjectResolution({ kind: "ambiguous", candidates });
        }
        catch {
            return null;
        }
    }
    return null;
}
function isUnresolvedReason(value) {
    return value === "no_git" || value === "no_match" || value === "unreadable";
}
function strictWrapperCandidates(values) {
    const paths = [];
    for (const candidate of values) {
        if (!isRecord(candidate) || !hasExactKeys(candidate, ["path"]) || typeof candidate.path !== "string") {
            return null;
        }
        paths.push(candidate.path);
    }
    return strictProposalCandidates(paths);
}
function strictProposalCandidates(values) {
    if (!Array.isArray(values) || values.length > MAX_LEXICAL_CANDIDATES)
        return null;
    const safeValues = [];
    for (const value of values) {
        if (typeof value !== "string" || !isVaultRelativeMarkdownPath(value))
            return null;
        safeValues.push(value);
    }
    return uniqueByKey(safeValues, (candidate) => normalizePathKey(candidate)).sort(stableCompare);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(record, expected) {
    const actual = Object.keys(record).sort(stableCompare);
    const sortedExpected = [...expected].sort(stableCompare);
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
/** Strict real ISO-8601 UTC timestamp check, canonicalized through Date. */
function isIsoUtcTimestamp(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match)
        return false;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
        return false;
    const fraction = (match[2] ?? "").padEnd(3, "0");
    return date.toISOString() === `${match[1]}.${fraction}Z`;
}
function parseRemoteParts(value) {
    let host = "";
    let remotePath = "";
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
    if (scheme) {
        const protocol = (scheme[1] ?? "").toLowerCase();
        if (protocol !== "https" && protocol !== "http" && protocol !== "ssh" && protocol !== "git") {
            return null;
        }
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            return null;
        }
        host = parsed.hostname;
        remotePath = parsed.pathname;
    }
    else {
        const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
        if (scp) {
            host = scp[1] ?? "";
            remotePath = scp[2] ?? "";
        }
        else {
            const slash = value.indexOf("/");
            if (slash <= 0)
                return null;
            host = value.slice(0, slash);
            remotePath = value.slice(slash + 1);
        }
    }
    remotePath = remotePath.replace(/^\/+|\/+$/g, "");
    if (remotePath.length === 0 || remotePath.includes("//"))
        return null;
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(remotePath);
    }
    catch {
        return null;
    }
    const segments = decodedPath.split("/");
    if (segments.length !== 2)
        return null;
    const owner = segments[0] ?? "";
    let name = segments[1] ?? "";
    if (/\.git$/i.test(name))
        name = name.slice(0, -4);
    if (name.length === 0 || owner.length === 0)
        return null;
    if (!host.includes(".") && host !== "localhost")
        return null;
    return { host, owner, name };
}
function isRemotePart(value) {
    return (value.length > 0 &&
        value.length <= 1024 &&
        !/[\s\u0000-\u001F\u007F/:@?#]/.test(value) &&
        value !== "." &&
        value !== "..");
}
function remoteKey(value) {
    return value.normalize("NFC").toLowerCase();
}
async function inspectGit(cwd, git) {
    if (typeof cwd !== "string" ||
        !path.isAbsolute(cwd) ||
        cwd.length > 4096 ||
        cwd.includes("\u0000")) {
        return { state: "no_git", remotes: [] };
    }
    try {
        const result = await git(["remote", "-v"], { cwd });
        if (!result.ok)
            return { state: "no_git", remotes: [] };
        if (Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
            Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES) {
            return { state: "no_git", remotes: [] };
        }
        return { state: "available", remotes: parseRemoteV(result.stdout) };
    }
    catch {
        return { state: "no_git", remotes: [] };
    }
}
async function scanProjectNotes(config, fs) {
    const vaultPaths = new VaultPaths(config.vault_path, {
        identity: config.vault_identity,
        attachmentsDir: config.layout.attachments_dir,
        fs,
    });
    const notes = [];
    const seen = new Set();
    const budget = { entries: 0, directories: 0 };
    try {
        await walkProjectDirectory(config.layout.projects_dir, 0, config.vault_path, fs, vaultPaths, seen, notes, budget);
    }
    catch {
        return { kind: "unreadable" };
    }
    return { kind: "ok", notes };
}
async function walkProjectDirectory(relativeDirectory, depth, vaultRoot, fs, vaultPaths, seen, notes, budget) {
    if (depth > MAX_SCAN_DEPTH) {
        throw new Error("project scan depth exceeded");
    }
    budget.directories += 1;
    if (budget.directories > MAX_SCAN_DIRECTORIES) {
        throw new Error("project scan directory budget exceeded");
    }
    // This validation is deliberately the closest possible precondition to the
    // directory read. It re-establishes config.vault_identity and containment;
    // the returned path remains only a validation snapshot per Task 2.
    const validatedDirectory = await vaultPaths.resolveDirectory(relativeDirectory, {
        automatic: true,
    });
    const entries = await fs.readdir(validatedDirectory.absolute);
    if (entries.length > MAX_SCAN_ENTRIES_PER_DIRECTORY) {
        throw new Error("project directory materialization budget exceeded");
    }
    budget.entries += entries.length;
    if (budget.entries > MAX_SCAN_ENTRIES) {
        throw new Error("project scan entry budget exceeded");
    }
    // A revalidation after readdir catches root/directory replacement before any
    // returned entry can influence selection. It does not claim atomicity.
    await vaultPaths.resolveDirectory(relativeDirectory, { automatic: true });
    entries.sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
        if (!isSafeDirectoryEntryName(entry.name)) {
            throw new Error("project directory entry name is malformed");
        }
        const isSymbolicLink = entry.isSymbolicLink();
        const isDirectory = entry.isDirectory();
        if (isSymbolicLink && isDirectory) {
            // Never follow a directory symlink from the lexical Dirent listing.
            // A symlinked Markdown target is still sent through resolveRead below so
            // an escaping target fails closed at the closest read boundary.
            continue;
        }
        const absolute = path.join(validatedDirectory.absolute, entry.name);
        if (isDirectory) {
            await walkProjectDirectory(`${relativeDirectory}/${entry.name}`, depth + 1, vaultRoot, fs, vaultPaths, seen, notes, budget);
            continue;
        }
        if (!entry.name.endsWith(".md"))
            continue;
        if (notes.length >= MAX_PROJECT_NOTES) {
            throw new Error("project note budget exceeded");
        }
        const relative = toVaultRelative(vaultRoot, absolute);
        if (!relative) {
            throw new Error("project note path is outside the vault");
        }
        const key = normalizePathKey(relative);
        if (seen.has(key))
            continue;
        seen.add(key);
        // Resolve the exact note path immediately before readFileBounded. VaultPaths
        // rechecks root identity, parent/target realpaths, lstat and followed stat
        // with fixed redacted errors; this is a validation snapshot, not an
        // impossible atomic authorization claim.
        const validatedNote = await vaultPaths.resolveRead(relative, { automatic: true });
        const source = await fs.readFileBounded(validatedNote.absolute, MAX_NOTE_BYTES);
        if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_NOTE_BYTES) {
            throw new Error("project note exceeds bounded size");
        }
        const note = parseProjectNote(source, relative, validatedNote.absolute);
        notes.push(note);
    }
}
function parseProjectNote(source, relative, absolute) {
    const parsed = parseNote(source);
    if (parsed.frontmatter.kind === "invalid") {
        // A delimited but invalid YAML block is not legacy/missing frontmatter.
        throw new Error("project note frontmatter is invalid");
    }
    const metadata = parsed.frontmatter.kind === "present"
        ? parsed.frontmatter.metadata
        : emptyMetadata();
    const portable = metadata.resyst_project;
    const portableId = portable ? portable.id : null;
    const projectId = portableId ?? deriveLegacyProjectId(path.basename(relative, ".md"));
    const parent = path.basename(path.dirname(absolute));
    const filename = path.basename(relative, ".md");
    const firstH1 = parsed.headings.find((heading) => heading.level === 1)?.text ?? null;
    const exactValues = [
        parent,
        filename,
        metadata.title ?? "",
        firstH1 ?? "",
        ...metadata.aliases,
    ];
    const exactNames = uniqueExactNames(exactValues);
    const repositories = uniqueStrings((portable?.repos ?? [])
        .map((repo) => normalizeRemote(repo))
        .filter((repo) => repo !== null)
        .map((repo) => remoteKey(repo.repo)));
    return {
        path: relative,
        portableId,
        projectId,
        portableAliases: portable?.aliases ?? [],
        repositories,
        exactNames,
        lexicalNames: uniqueStrings([
            ...exactNames.map((name) => name.value),
            portable?.id ?? "",
            ...(portable?.aliases ?? []),
            ...(portable?.repos ?? []),
        ]),
    };
}
function emptyMetadata() {
    return { title: null, date: null, tags: [], aliases: [], resyst_project: null };
}
function uniqueExactNames(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== "string" || value.length === 0)
            continue;
        const key = value.normalize("NFC");
        if (key.length === 0 || seen.has(key))
            continue;
        seen.add(key);
        out.push({ value, projectId: deriveLegacyProjectId(value) });
    }
    return out;
}
function isSafeDirectoryEntryName(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        value.length <= 1024 &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !/[\u0000-\u001F\u007F]/.test(value));
}
function selectNotes(notes, basis) {
    const unique = dedupeNotes(notes);
    if (unique.length === 0)
        return null;
    if (unique.length > 1)
        return ambiguous(unique);
    const note = unique[0];
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
function selectExactNotes(notes, query) {
    const unique = dedupeNotes(notes);
    if (unique.length === 0)
        return null;
    const matchedByNote = unique.map((note) => note.exactNames.filter((name) => normalizeMatch(name.value) === query));
    // Validate every legacy matched source before returning >=2-note ambiguity:
    // an unsafe source must not be masked by another safe candidate, and one
    // note must never manufacture a one-candidate ambiguity from conflicts.
    const idsByNote = unique.map((note, index) => {
        const matched = matchedByNote[index];
        if (matched.length === 0)
            return null;
        // Portable identity is authoritative and does not depend on legacy name
        // values (which may be arbitrary Unicode or otherwise non-ID-shaped).
        if (note.portableId !== null)
            return [note.portableId];
        if (matched.some((name) => name.projectId === null))
            return null;
        return uniqueByKey(matched.map((name) => name.projectId), (id) => id.normalize("NFC"));
    });
    if (idsByNote.some((ids) => ids === null || ids.length !== 1)) {
        return { kind: "unresolved", reason: "unreadable" };
    }
    if (unique.length > 1)
        return ambiguous(unique);
    const note = unique[0];
    const ids = idsByNote[0];
    return {
        kind: "resolved",
        project_id: (note.portableId ?? ids[0]),
        basis: "exact_name",
        note_path: note.path,
    };
}
function ambiguous(notes) {
    return {
        kind: "ambiguous",
        candidates: dedupeNotes(notes).map((note) => note.path).sort(stableCompare),
    };
}
function dedupeNotes(notes) {
    const byPath = new Map();
    for (const note of notes) {
        const key = normalizePathKey(note.path);
        if (!byPath.has(key))
            byPath.set(key, note);
    }
    return [...byPath.values()].sort((left, right) => stableCompare(left.path, right.path));
}
async function findExactOverrides(config, cwd, fs) {
    if (config.project_overrides.length === 0)
        return [];
    let canonicalCwd;
    try {
        canonicalCwd = await fs.realpath(cwd);
    }
    catch {
        return [];
    }
    const matches = [];
    for (const override of config.project_overrides) {
        try {
            const canonicalOverride = await fs.realpath(path.resolve(override.path));
            if (canonicalOverride === canonicalCwd)
                matches.push(override.project_id);
        }
        catch {
            // An override whose target disappeared is not an exact match.
        }
    }
    return matches;
}
function rankLexicalCandidates(notes, query) {
    const ranked = [];
    for (const note of notes) {
        let best = Number.POSITIVE_INFINITY;
        for (const value of note.lexicalNames) {
            const candidate = normalizeMatch(value);
            if (candidate.length === 0 || query.length === 0)
                continue;
            if (candidate.startsWith(query) || query.startsWith(candidate)) {
                best = Math.min(best, 1);
            }
            else if (candidate.includes(query) || query.includes(candidate)) {
                best = Math.min(best, 2);
            }
            else {
                const queryTokens = query.split(" ").filter((token) => token.length > 0);
                if (queryTokens.some((token) => candidate.includes(token)))
                    best = Math.min(best, 3);
            }
        }
        if (Number.isFinite(best))
            ranked.push({ note, score: best });
    }
    return ranked
        .sort((left, right) => left.score - right.score || stableCompare(left.note.path, right.note.path))
        .slice(0, MAX_LEXICAL_CANDIDATES)
        .map((item) => item.note);
}
/** Derive a legacy id only from a safe metadata/name value. */
function deriveLegacyProjectId(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 1024 ||
        value.trim().length === 0 ||
        value.includes("/") ||
        value.includes("\\") ||
        /[\u0000-\u001F\u007F]/.test(value)) {
        return null;
    }
    return deriveProjectId(value);
}
function deriveProjectId(stem) {
    const normalized = stem.normalize("NFC");
    let value = "";
    let separator = false;
    for (const character of normalized) {
        if (/^[A-Za-z0-9]$/.test(character)) {
            value += character;
            separator = false;
        }
        else if (value.length > 0 && !separator) {
            value += "-";
            separator = true;
        }
        if (value.length >= 128)
            break;
    }
    value = value.replace(/-+$/g, "");
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
        ? value
        : null;
}
function normalizeMatch(value) {
    return value
        .normalize("NFC")
        .trim()
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .toLowerCase();
}
function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== "string" || value.length === 0)
            continue;
        const key = normalizeMatch(value);
        if (key.length === 0 || seen.has(key))
            continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}
function uniqueByKey(values, keyOf) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const key = keyOf(value);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}
function toVaultRelative(vaultRoot, absolute) {
    const relative = path.relative(vaultRoot, absolute).split(path.sep).join("/");
    if (!isVaultRelativeMarkdownPath(relative))
        return null;
    return relative;
}
function isVaultRelativeMarkdownPath(value) {
    if (value.length === 0 ||
        value.length > 1024 ||
        value.startsWith("/") ||
        value.includes("\\") ||
        !value.endsWith(".md") ||
        /[\u0000-\u001F\u007F]/.test(value)) {
        return false;
    }
    const parts = value.split("/");
    return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}
function normalizePathKey(value) {
    return value.normalize("NFC");
}
function trimTrailingSeparators(value) {
    return value.replace(/[\\/]+$/g, "");
}
function stableCompare(left, right) {
    const leftKey = left.normalize("NFC").toLowerCase();
    const rightKey = right.normalize("NFC").toLowerCase();
    if (leftKey < rightKey)
        return -1;
    if (leftKey > rightKey)
        return 1;
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
