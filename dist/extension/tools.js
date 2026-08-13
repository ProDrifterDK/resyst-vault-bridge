import { Type } from "typebox";
import { loadConfig } from "../config.js";
import { readVaultNote, searchVault, nodeSearchCacheStore, } from "../search.js";
import { VaultPathError, VaultPaths, nodeVaultPathsFs, } from "../paths.js";
import { resolveProject, } from "../project.js";
import { buildBootstrap, } from "../bootstrap.js";
import { VAULT_PATH_PATTERN } from "../schemas.js";
import { nodeSnapshotFs, readSnapshotFile, } from "../snapshot.js";
export { SNAPSHOT_OPEN_FLAGS, SnapshotReadError, } from "../snapshot.js";
/** Fixed user-facing message returned for every tool failure. */
export const TOOL_UNAVAILABLE_MESSAGE = "vault tool unavailable";
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
const SearchParameters = Type.Object({
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    limit: Type.Optional(Type.Integer({ minimum: MIN_LIMIT, maximum: MAX_LIMIT })),
}, { additionalProperties: false });
/**
 * TypeBox parameters for the read tool: bounded vault-relative path (no
 * dot segments, no leading slash, no traversal, no backslashes) plus an
 * optional bounded heading string.
 */
const ReadParameters = Type.Object({
    path: Type.String({
        minLength: 1,
        maxLength: MAX_PATH_LENGTH,
        pattern: VAULT_PATH_PATTERN,
    }),
    heading: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_HEADING_LENGTH })),
}, { additionalProperties: false });
function successDetails() {
    return { version: 1, outcome: "ok" };
}
function unavailableDetails() {
    return { version: 1, outcome: "unavailable" };
}
function unavailableResult() {
    return {
        content: [{ type: "text", text: TOOL_UNAVAILABLE_MESSAGE }],
        details: unavailableDetails(),
    };
}
function forwardSearch(service) {
    return async (_callId, params) => {
        try {
            const forwarded = {
                query: params.query,
                ...(params.limit === undefined ? {} : { limit: params.limit }),
            };
            const result = await service.search(forwarded);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: successDetails(),
            };
        }
        catch {
            return unavailableResult();
        }
    };
}
function forwardRead(service) {
    return async (_callId, params) => {
        try {
            const forwarded = {
                path: params.path,
                ...(params.heading === undefined ? {} : { heading: params.heading }),
            };
            const result = await service.read(forwarded);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: successDetails(),
            };
        }
        catch {
            return unavailableResult();
        }
    };
}
function searchToolDefinition(service) {
    return {
        name: "vault_search",
        label: "Vault Search",
        description: "Search the configured Obsidian vault for notes matching the bounded query.",
        parameters: SearchParameters,
        execute: forwardSearch(service),
    };
}
function readToolDefinition(service) {
    return {
        name: "vault_read",
        label: "Vault Read",
        description: "Read one bounded note or one exact heading section from the configured Obsidian vault.",
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
export function registerReadTools(api, service) {
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
function dailyRelativePath(dailyDir, isoDate) {
    return `${dailyDir}/${isoDate}.md`;
}
/** Default UTC date provider: ISO date `YYYY-MM-DD`. */
function defaultDateProvider(now = () => new Date()) {
    return () => now().toISOString().slice(0, 10);
}
/**
 * Build a complete `BridgeReadService` backed by the shared core. Returns
 * real results; failures surface as thrown errors that the adapter maps to
 * the fixed unavailable tool result.
 */
export function createProductionService(deps = {}) {
    const dateProvider = defaultDateProvider(deps.now);
    const vaultPathsFs = deps.vaultPathsFs ?? nodeVaultPathsFs;
    const snapshotFs = deps.snapshotFs ?? nodeSnapshotFs;
    return {
        bootstrap: (input) => bootstrapOnce(input, deps, dateProvider, vaultPathsFs, snapshotFs),
        search: (input) => searchOnce(input, deps),
        read: (input) => readOnce(input, deps),
    };
}
async function searchOnce(input, deps) {
    const config = await loadOnce(deps);
    return await searchVault({
        config,
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(deps.searchFs === undefined ? {} : { fs: deps.searchFs }),
        ...(deps.xdgStateHome === undefined
            ? {}
            : { cache: nodeSearchCacheStore({ xdgStateHome: deps.xdgStateHome }) }),
    });
}
async function readOnce(input, deps) {
    const config = await loadOnce(deps);
    return await readVaultNote({
        config,
        path: input.path,
        ...(input.heading === undefined ? {} : { heading: input.heading }),
        ...(deps.searchFs === undefined ? {} : { fs: deps.searchFs }),
    });
}
async function loadOnce(deps) {
    return await loadConfig({
        ...(deps.configFs === undefined ? {} : { fs: deps.configFs }),
        ...(deps.home === undefined ? {} : { home: deps.home }),
        ...(deps.xdgConfigHome === undefined
            ? {}
            : { xdgConfigHome: deps.xdgConfigHome }),
    });
}
async function bootstrapOnce(input, deps, dateProvider, vaultPathsFs, snapshotStatFs) {
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
    const claude = await readOptionalSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, CLAUDE_RELATIVE_PATH);
    const dailyPath = dailyRelativePath(config.layout.daily_dir, dateProvider());
    const currentDaily = await readOptionalSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, dailyPath);
    const moc = await readOptionalSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, MOC_RELATIVE_PATH);
    const projectNote = await readRequiredProjectSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, project);
    const bootstrapConfig = {
        budget_tokens: config.budget.context_tokens,
        managed_headings: config.managed_headings,
    };
    const estimateTokens = (value) => Math.ceil(Array.from(value).length / CHARS_PER_TOKEN);
    const buildInput = {
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
async function readOptionalSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, vaultRelative) {
    let resolved;
    try {
        resolved = await vaultPaths.resolveRead(vaultRelative, {
            automatic: false,
        });
    }
    catch (error) {
        if (error instanceof VaultPathError && error.code === "target_missing") {
            return null;
        }
        throw error;
    }
    return await readSnapshotFile(snapshotStatFs, vaultPaths, trustedRootReal, resolved, MAX_SNAPSHOT_BYTES);
}
async function readRequiredProjectSnapshot(vaultPaths, snapshotStatFs, trustedRootReal, project) {
    if (project.kind !== "resolved")
        return null;
    if (project.note_path === null)
        return null;
    const resolved = await vaultPaths.resolveRead(project.note_path, {
        automatic: false,
    });
    return await readSnapshotFile(snapshotStatFs, vaultPaths, trustedRootReal, resolved, MAX_SNAPSHOT_BYTES);
}
