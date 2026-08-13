#!/usr/bin/env node
/**
 * Stable JSON CLI over the shared core.
 *
 * Frozen contract:
 * - Diagnostics: closed fixed strings only; no caller-data concatenation.
 * - XDG: one absolute state root; relative env fail-closed.
 * - Import safety: importing `runCli` installs no signal handler, reads no
 *   stdin, exits nothing. SIGINT is registered only in executable main,
 *   gated by `import.meta.url === pathToFileURL(argv[1]).href`.
 * - External JSON: TypeBox exact (`additionalProperties: false`) CLI schemas
 *   bound by byte/depth/node/string budgets.
 * - Framing: search/read/bootstrap accept 1..128 JSONL requests; checkpoint
 *   exactly one; doctor/status/recover/rollback/help are bodyless and
 *   reject nonempty piped bodies; the entire stdin framing is parsed and
 *   validated before any service effect.
 * - Argv grammar: global `--no-color` (accepted/ignored once); checkpoint
 *   requires exactly one of `--dry-run`/`--apply`; doctor optionally one
 *   `--clean-abandoned-lock`; rollback requires exactly one validated
 *   `EventId` positional; every other command takes zero args.
 * - Doctor: default read-only; explicit cleanup via `--clean-abandoned-lock`.
 * - Deterministic IDs: apply event id derived from the validated normalized
 *   idempotency key (prefix `apply-`), never from raw JSON order.
 * - Exit mappings per command per the adjudication table.
 */
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { buildBootstrap } from "./bootstrap.js";
import { readVaultNote, searchVault, SearchError, VaultReadError } from "./search.js";
import { buildWritePlans } from "./render.js";
import { normalizeCheckpoint } from "./checkpoint.js";
import { DoctorService, StatusService } from "./status.js";
import { RecoveryService } from "./recovery.js";
import { RollbackService } from "./rollback.js";
import { TransactionService, TransactionIntegrityError } from "./transaction.js";
import { JournalIntegrityError, JournalStore } from "./journal.js";
import { LocalLock } from "./lock.js";
import { VaultPaths, nodeVaultPathsFs } from "./paths.js";
import { nodeSearchCacheStore } from "./search.js";
import { loadConfig, ConfigError } from "./config.js";
import { ApplyCheckpointSchema, EventIdSchema, IdempotencyKeySchema, IsoTimestampSchema, NoopCheckpointSchema, ProjectResolutionSchema, VaultPathSchema, parseWithSchema, } from "./schemas.js";
const PROTOCOL_VERSION = 1;
// Exit codes (stable, symbolic).
const EXIT_OK = 0;
const EXIT_INVALID = 2;
const EXIT_UNAVAILABLE = 3;
const EXIT_DEFERRED = 4;
const EXIT_RECOVERY_REQUIRED = 5;
const EXIT_ROLLBACK_PRECONDITION = 6;
const EXIT_SIGINT = 130;
// Framing limits.
const MAX_STDIN_BYTES = 8 * 1024 * 1024; // 8 MiB total
const MAX_STDIN_NONBLANK_LINES = 128;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_STRING_LENGTH = 1_000_000;
// Search bounds.
const MIN_SEARCH_QUERY_LEN = 1;
const MAX_SEARCH_QUERY_LEN = 256;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 32;
// Body-based per-command limits.
const MIN_FRAME_REQUESTS = 1;
const MAX_FRAME_REQUESTS = 128;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_INVOCATION_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_NODES = 200_000;
const MAX_OUTPUT_DEPTH = 128;
const MAX_OUTPUT_STRING_LENGTH = 16 * 1024 * 1024;
// Bootstrap source/snapshot ceiling.
const MAX_SNAPSHOT_SOURCE_CHARS = 1_000_000;
const MIN_BUDGET_TOKENS = 1;
const MAX_BUDGET_TOKENS = 1_000_000;
// Read bound.
const MAX_READ_HEADING_LEN = 512;
const COMMAND_NAMES = [
    "doctor",
    "status",
    "search",
    "read",
    "bootstrap",
    "checkpoint",
    "recover",
    "rollback",
    "help",
];
const HELP_TEXT = [
    "resyst-vault — version " + String(PROTOCOL_VERSION),
    "",
    "Stable JSON CLI. Each command reads stdin as documented framing;",
    "diagnostics on stderr are closed fixed strings (no payload echo).",
    "",
    "USAGE",
    "  resyst-vault <command> [options] [--no-color]",
    "",
    "COMMANDS",
    "  doctor [--clean-abandoned-lock]   Read-only health report.",
    "                                   Optional explicit lock cleanup.",
    "  status                           Pending/deferred/applied counts.",
    "  search <jsonl>                   Lexical vault search (1..128 reqs).",
    "  read <jsonl>                     Read note or heading (1..128 reqs).",
    "  bootstrap <jsonl>                Build root-turn context (1..128).",
    "  checkpoint (--dry-run|--apply) <single-json>",
    "                                   Plan or apply one checkpoint.",
    "  recover                          Replay pending journal events.",
    "  rollback <event-id>              Roll back one applied event.",
    "  help                             Print this message.",
    "",
    "OPTIONS",
    "  --no-color       Accepted and ignored (no ANSI is ever emitted).",
    "",
    "EXIT CODES",
    "  0  success, no-op, or already applied",
    "  2  invalid request or invalid configuration",
    "  3  vault unavailable",
    "  4  deferred conflict",
    "  5  recovery required or invalid state",
    "  6  rollback precondition failed",
    "  130  SIGINT (no partial stdout while waiting on stdin)",
    "",
    "The CLI never echoes payload values on stderr.",
].join("\n");
// ---------------------------------------------------------------------------
// Closed fixed diagnostic strings. Caller-supplied values (paths, errors,
// payloads) are NEVER concatenated into these strings.
// ---------------------------------------------------------------------------
const DIAG = {
    INVALID_REQUEST: "invalid_request",
    INVALID_CONFIG: "invalid_config",
    UNAVAILABLE: "unavailable",
    INVALID_STATE: "invalid_state",
    RECOVERY_REQUIRED: "recovery_required",
    DEFERRED: "deferred",
};
const FIXED_STDERR = {
    missing_command: "invalid_request: missing command",
    unknown_command: "invalid_request: unknown command",
    bodyless_command_with_body: "invalid_request: bodyless command received stdin",
    no_color_repeated: "invalid_request: --no-color repeated",
    checkpoint_mode_required: "invalid_request: checkpoint requires --dry-run or --apply",
    checkpoint_mode_exclusive: "invalid_request: --dry-run and --apply are mutually exclusive",
    doctor_extra_flag: "invalid_request: doctor accepts only --clean-abandoned-lock",
    doctor_extra_positional: "invalid_request: doctor takes no positional argument",
    rollback_missing_id: "invalid_request: rollback requires a target event id",
    rollback_extra_positional: "invalid_request: rollback takes exactly one positional event id",
    rollback_invalid_id: "invalid_request: rollback target is not a valid event id",
    too_many_requests: "invalid_request: too many requests in JSONL",
    no_requests: "invalid_request: JSONL contains no requests",
    malformed_line: "invalid_request: malformed JSON in request",
    stdin_overflow: "invalid_request: stdin exceeds bounded size",
    stdin_too_many_lines: "invalid_request: stdin exceeds bounded line count",
    json_depth: "invalid_request: JSON exceeds bounded depth",
    json_nodes: "invalid_request: JSON exceeds bounded node count",
    json_string: "invalid_request: JSON string exceeds bounded length",
};
// ---------------------------------------------------------------------------
// TypeBox CLI schemas. Each input is `additionalProperties: false` so unknown
// keys are rejected at the validation boundary.
// ---------------------------------------------------------------------------
const BootstrapSnapshotSchema = Type.Object({
    path: VaultPathSchema,
    source: Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
    modified_at: IsoTimestampSchema,
}, { additionalProperties: false });
const SearchRequestSchema = Type.Object({
    query: Type.String({
        minLength: MIN_SEARCH_QUERY_LEN,
        maxLength: MAX_SEARCH_QUERY_LEN,
    }),
    limit: Type.Optional(Type.Integer({ minimum: MIN_SEARCH_LIMIT, maximum: MAX_SEARCH_LIMIT })),
}, { additionalProperties: false });
const ReadRequestSchema = Type.Object({
    path: VaultPathSchema,
    heading: Type.Optional(Type.Union([
        Type.String({ minLength: 1, maxLength: MAX_READ_HEADING_LEN }),
        Type.Null(),
    ])),
}, { additionalProperties: false });
const BootstrapRequestSchema = Type.Object({
    notes: Type.Object({
        claude: Type.Union([BootstrapSnapshotSchema, Type.Null()]),
        current_daily: Type.Union([BootstrapSnapshotSchema, Type.Null()]),
        project: Type.Union([BootstrapSnapshotSchema, Type.Null()]),
        moc: Type.Optional(Type.Union([BootstrapSnapshotSchema, Type.Null()])),
    }, { additionalProperties: false }),
    project: ProjectResolutionSchema,
    budget_tokens: Type.Optional(Type.Integer({ minimum: MIN_BUDGET_TOKENS, maximum: MAX_BUDGET_TOKENS })),
}, { additionalProperties: false });
const CheckpointApplyRequestSchema = Type.Object({
    checkpoint: ApplyCheckpointSchema,
    project: ProjectResolutionSchema,
    project_title: Type.Union([
        Type.String({ minLength: 1, maxLength: 1024 }),
        Type.Null(),
    ]),
    snapshots: Type.Object({
        daily: Type.Union([
            Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
            Type.Null(),
        ]),
        project: Type.Union([
            Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
            Type.Null(),
        ]),
        moc: Type.Union([
            Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
            Type.Null(),
        ]),
        claude: Type.Union([
            Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
            Type.Null(),
        ]),
    }, { additionalProperties: false }),
    template_source: Type.Union([
        Type.String({ minLength: 0, maxLength: MAX_SNAPSHOT_SOURCE_CHARS }),
        Type.Null(),
    ]),
    date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
}, { additionalProperties: false });
const CheckpointNoopRequestSchema = Type.Object({
    checkpoint: NoopCheckpointSchema,
}, { additionalProperties: false });
function parseArgs(argv) {
    if (argv.length === 0) {
        return { ok: false, exit: EXIT_INVALID, stderr: FIXED_STDERR.missing_command };
    }
    const command = argv[0];
    if (!COMMAND_NAMES.includes(command)) {
        return {
            ok: false,
            exit: EXIT_INVALID,
            stderr: FIXED_STDERR.unknown_command,
        };
    }
    // Global --no-color: accepted/ignored once, repeated => invalid.
    let noColorCount = 0;
    const rest = [];
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--no-color") {
            noColorCount += 1;
            if (noColorCount > 1) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.no_color_repeated,
                };
            }
            continue;
        }
        if (arg === undefined)
            continue;
        rest.push(arg);
    }
    const positionals = [];
    const flags = [];
    for (const arg of rest) {
        if (arg.startsWith("--") || arg.startsWith("-"))
            flags.push(arg);
        else
            positionals.push(arg);
    }
    switch (command) {
        case "help":
            if (rest.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            return { ok: true, plan: { kind: "help" } };
        case "doctor": {
            let clean = false;
            for (const flag of flags) {
                if (flag === "--clean-abandoned-lock") {
                    if (clean) {
                        return {
                            ok: false,
                            exit: EXIT_INVALID,
                            stderr: FIXED_STDERR.doctor_extra_flag,
                        };
                    }
                    clean = true;
                    continue;
                }
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.doctor_extra_positional,
                };
            }
            return { ok: true, plan: { kind: "doctor", cleanAbandonedLock: clean } };
        }
        case "status":
            if (flags.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            return { ok: true, plan: { kind: "status" } };
        case "search":
        case "read":
        case "bootstrap":
            if (flags.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            return { ok: true, plan: { kind: command } };
        case "checkpoint": {
            let dryRun = false;
            let apply = false;
            for (const flag of flags) {
                if (flag === "--dry-run") {
                    if (dryRun) {
                        return {
                            ok: false,
                            exit: EXIT_INVALID,
                            stderr: FIXED_STDERR.checkpoint_mode_required,
                        };
                    }
                    dryRun = true;
                    continue;
                }
                if (flag === "--apply") {
                    if (apply) {
                        return {
                            ok: false,
                            exit: EXIT_INVALID,
                            stderr: FIXED_STDERR.checkpoint_mode_required,
                        };
                    }
                    apply = true;
                    continue;
                }
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            return { ok: true, plan: { kind: "checkpoint", dryRun, apply } };
        }
        case "recover":
            if (flags.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            return { ok: true, plan: { kind: "recover" } };
        case "rollback": {
            if (flags.length > 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.unknown_command,
                };
            }
            if (positionals.length === 0) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.rollback_missing_id,
                };
            }
            if (positionals.length > 1) {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.rollback_extra_positional,
                };
            }
            const target = positionals[0];
            // Validate against EventIdSchema up front so unknown shapes fail closed.
            try {
                parseWithSchema(EventIdSchema, target, "rollback target event id");
            }
            catch {
                return {
                    ok: false,
                    exit: EXIT_INVALID,
                    stderr: FIXED_STDERR.rollback_invalid_id,
                };
            }
            return { ok: true, plan: { kind: "rollback", eventId: target } };
        }
    }
    return {
        ok: false,
        exit: EXIT_INVALID,
        stderr: FIXED_STDERR.unknown_command,
    };
}
// ---------------------------------------------------------------------------
// Bounded stdin reader and JSON validators.
// ---------------------------------------------------------------------------
async function readStdinBounded(io) {
    const chunks = [];
    let total = 0;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            io.stdin.removeAllListeners("data");
            io.stdin.removeAllListeners("end");
            io.stdin.removeAllListeners("close");
            io.stdin.removeAllListeners("error");
        };
        const finish = () => {
            cleanup();
            try {
                resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            }
            catch (error) {
                reject(error instanceof Error ? error : new Error("stdin read failed"));
            }
        };
        io.stdin.on("data", (chunk) => {
            const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            total += buffer.length;
            if (total > MAX_STDIN_BYTES) {
                cleanup();
                reject(new Error(FIXED_STDERR.stdin_overflow));
                return;
            }
            chunks.push(buffer);
        });
        io.stdin.once("end", () => finish());
        io.stdin.once("close", () => finish());
        io.stdin.once("error", (error) => {
            cleanup();
            reject(error instanceof Error ? error : new Error("stdin read failed"));
        });
    });
}
/** Iteratively validate one parsed JSON value: bounded depth/nodes/strings. */
function validateBoundedValue(value, limits = {
    depth: MAX_JSON_DEPTH,
    nodes: MAX_JSON_NODES,
    stringLength: MAX_STRING_LENGTH,
}) {
    const stack = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
        const frame = stack.pop();
        nodes += 1;
        if (nodes > limits.nodes)
            return FIXED_STDERR.json_nodes;
        if (frame.depth > limits.depth)
            return FIXED_STDERR.json_depth;
        if (typeof frame.value === "string") {
            if (frame.value.length > limits.stringLength)
                return FIXED_STDERR.json_string;
            continue;
        }
        if (frame.value === null || typeof frame.value !== "object")
            continue;
        if (Array.isArray(frame.value)) {
            for (let index = frame.value.length - 1; index >= 0; index -= 1) {
                stack.push({ value: frame.value[index], depth: frame.depth + 1 });
            }
            continue;
        }
        const record = frame.value;
        const keys = Object.keys(record);
        for (let index = keys.length - 1; index >= 0; index -= 1) {
            const key = keys[index];
            if (key.length > limits.stringLength)
                return FIXED_STDERR.json_string;
            stack.push({ value: record[key], depth: frame.depth + 1 });
        }
    }
    return null;
}
/** Parse stdin into a list of JSON values, one per nonblank line. */
async function readFramedRequests(io, options) {
    // Bodyless interactive TTY must not block on stdin.
    if (io.stdinIsTTY && !options.requireBody) {
        return { ok: true, lines: [] };
    }
    let raw;
    try {
        raw = await readStdinBounded(io);
    }
    catch (error) {
        if (error instanceof Error &&
            error.message === FIXED_STDERR.stdin_overflow) {
            return {
                ok: false,
                exit: EXIT_INVALID,
                stderr: FIXED_STDERR.stdin_overflow,
            };
        }
        return {
            ok: false,
            exit: EXIT_INVALID,
            stderr: FIXED_STDERR.stdin_overflow,
        };
    }
    if (raw.length === 0) {
        if (!options.requireBody)
            return { ok: true, lines: [] };
        return {
            ok: false,
            exit: EXIT_INVALID,
            stderr: FIXED_STDERR.no_requests,
        };
    }
    if (!options.requireBody) {
        return {
            ok: false,
            exit: EXIT_INVALID,
            stderr: FIXED_STDERR.bodyless_command_with_body,
        };
    }
    const text = raw.replace(/\r\n/gu, "\n");
    const split = text.split("\n");
    const lines = [];
    for (const line of split) {
        if (line.trim().length === 0)
            continue;
        if (lines.length >= MAX_STDIN_NONBLANK_LINES) {
            return {
                ok: false,
                exit: EXIT_INVALID,
                stderr: FIXED_STDERR.stdin_too_many_lines,
            };
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return {
                ok: false,
                exit: EXIT_INVALID,
                stderr: FIXED_STDERR.malformed_line,
            };
        }
        const bounded = validateBoundedValue(parsed);
        if (bounded !== null) {
            return {
                ok: false,
                exit: EXIT_INVALID,
                stderr: bounded,
            };
        }
        lines.push(parsed);
    }
    if (lines.length === 0) {
        if (!options.requireBody)
            return { ok: true, lines: [] };
        return {
            ok: false,
            exit: EXIT_INVALID,
            stderr: FIXED_STDERR.no_requests,
        };
    }
    return { ok: true, lines };
}
// ---------------------------------------------------------------------------
// State root resolution.
// ---------------------------------------------------------------------------
class CliBootstrapError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "CliBootstrapError";
    }
}
/** Resolve an absolute state root or fail closed. */
function resolveStateRoot() {
    const xdgState = process.env.XDG_STATE_HOME;
    if (xdgState !== undefined && xdgState.length > 0) {
        if (!path.isAbsolute(xdgState))
            throw new CliBootstrapError("invalid_state_root");
        return path.resolve(xdgState);
    }
    const home = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(home))
        throw new CliBootstrapError("invalid_state_root");
    return path.resolve(home, ".local", "state");
}
/** Resolve an absolute config root or fail closed. */
function resolveConfigRoot() {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig !== undefined && xdgConfig.length > 0) {
        if (!path.isAbsolute(xdgConfig))
            throw new CliBootstrapError("invalid_config");
        return path.resolve(xdgConfig);
    }
    const home = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(home))
        throw new CliBootstrapError("invalid_config");
    return path.resolve(home, ".config");
}
async function buildServices(stateRoot) {
    const configRoot = resolveConfigRoot();
    const config = await loadConfig({ xdgConfigHome: configRoot });
    const paths = new VaultPaths(config.vault_path, {
        identity: config.vault_identity,
        attachmentsDir: config.layout.attachments_dir,
        fs: nodeVaultPathsFs,
    });
    const journal = new JournalStore({
        vaultRoot: config.vault_path,
        identity: config.vault_identity,
    });
    const lock = new LocalLock({ stateRoot });
    const transaction = new TransactionService({
        vaultRoot: config.vault_path,
        stateRoot,
        config,
        paths,
        journal,
        lock,
    });
    const recovery = new RecoveryService({ journal, transaction });
    const status = new StatusService({ journal });
    const searchCache = nodeSearchCacheStore({ xdgStateHome: stateRoot });
    const doctor = new DoctorService({
        config,
        journal,
        lock,
        paths,
        cache: searchCache,
    });
    const rollback = new RollbackService({
        vaultRoot: config.vault_path,
        stateRoot,
        identity: config.vault_identity,
        paths,
        journal,
        lock,
    });
    return {
        config,
        stateRoot,
        journal,
        paths,
        lock,
        transaction,
        recovery,
        status,
        doctor,
        searchCache,
        rollback,
    };
}
// ---------------------------------------------------------------------------
// Diagnostics and response encoding.
// ---------------------------------------------------------------------------
function envelope(command, fields) {
    return { version: PROTOCOL_VERSION, command, ...fields };
}
function failure(command, outcome, fields = {}) {
    return envelope(command, { outcome, ...fields });
}
function safeRecord(value) {
    // The CLI envelopes are explicitly constructed symbolic fields; the
    // vault identity (a `bigint` dev/ino) is never serialized here. We do
    // not coerce `bigint` to string: if one ever leaks into an envelope,
    // `JSON.stringify` will throw so the bug surfaces instead of being
    // masked as a stringified number. Cycles are still neutralized so an
    // accidental self-reference cannot hang the process.
    const seen = new WeakSet();
    const visit = (current) => {
        if (current === null || current === undefined)
            return current;
        if (typeof current !== "object")
            return current;
        if (seen.has(current))
            return null;
        seen.add(current);
        if (Array.isArray(current)) {
            return current.map((item) => visit(item));
        }
        const record = current;
        const result = {};
        for (const key of Object.keys(record)) {
            result[key] = visit(record[key]);
        }
        return result;
    };
    return (visit(value) ?? {});
}
function encodeResponse(value) {
    return JSON.stringify(safeRecord(value));
}
class ResponseLimitError extends Error {
    constructor() {
        super("response exceeds bounded size");
        this.name = "ResponseLimitError";
    }
}
function writeStdout(io, value) {
    const bounded = validateBoundedValue(value, {
        depth: MAX_OUTPUT_DEPTH,
        nodes: MAX_OUTPUT_NODES,
        stringLength: MAX_OUTPUT_STRING_LENGTH,
    });
    if (bounded !== null)
        throw new ResponseLimitError();
    const encoded = encodeResponse(value);
    const bytes = Buffer.byteLength(encoded, "utf8") + 1;
    const prior = io.outputBytes ?? 0;
    if (bytes > MAX_RESPONSE_BYTES || prior + bytes > MAX_INVOCATION_OUTPUT_BYTES) {
        throw new ResponseLimitError();
    }
    io.outputBytes = prior + bytes;
    io.stdout.write(encoded + "\n");
}
/** Closed fixed stderr line for known outcomes. Never echo caller values. */
function stderrForOutcome(outcome) {
    switch (outcome) {
        case "invalid_request":
            return `${DIAG.INVALID_REQUEST}: details redacted`;
        case "invalid_config":
            return `${DIAG.INVALID_CONFIG}: details redacted`;
        case "unavailable":
            return `${DIAG.UNAVAILABLE}: service failed`;
        case "invalid_state":
            return `${DIAG.INVALID_STATE}: details redacted`;
        case "recovery_required":
            return `${DIAG.RECOVERY_REQUIRED}: details redacted`;
        case "deferred":
            return `${DIAG.DEFERRED}: details redacted`;
        default:
            return `${DIAG.UNAVAILABLE}: service failed`;
    }
}
function stderrFixed(io, message) {
    io.stderr.write(message + "\n");
}
function configErrorExit(error) {
    return error.code.startsWith("vault_") || error.code.startsWith("layout_")
        ? EXIT_UNAVAILABLE
        : EXIT_INVALID;
}
function writeConfigFailure(io, command, error) {
    const exit = configErrorExit(error);
    const outcome = exit === EXIT_UNAVAILABLE ? DIAG.UNAVAILABLE : DIAG.INVALID_CONFIG;
    writeStdout(io, failure(command, outcome));
    stderrFixed(io, stderrForOutcome(outcome));
    return exit;
}
function validCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (match === null)
        return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------
function planCommandName(plan) {
    if (plan.kind === "rollback")
        return "rollback";
    if (plan.kind === "checkpoint")
        return "checkpoint";
    return plan.kind;
}
function isBodylessCommand(plan) {
    switch (plan.kind) {
        case "doctor":
        case "status":
        case "recover":
        case "rollback":
        case "help":
            return true;
        case "search":
        case "read":
        case "bootstrap":
        case "checkpoint":
            return false;
    }
}
async function runDoctor(io, plan) {
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("doctor", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    try {
        const services = await buildServices(stateRoot);
        const report = await services.doctor.check();
        if (plan.cleanAbandonedLock) {
            const cleanup = await services.doctor.cleanAbandonedLock();
            const cleaned = cleanup === "removed" || cleanup === "not_abandoned";
            writeStdout(io, envelope("doctor", {
                outcome: cleaned ? "lock_cleanup_ok" : "lock_cleanup_refused",
                report,
                cleanup,
            }));
            return cleaned ? EXIT_OK : EXIT_DEFERRED;
        }
        writeStdout(io, envelope("doctor", { outcome: report.overall, report }));
        return EXIT_OK;
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("doctor", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "doctor", error);
        }
        writeStdout(io, failure("doctor", DIAG.UNAVAILABLE));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
}
async function runStatus(io) {
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("status", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    try {
        const services = await buildServices(stateRoot);
        const report = await services.status.report();
        if (report.recovery_required) {
            writeStdout(io, envelope("status", {
                outcome: DIAG.RECOVERY_REQUIRED,
                recovery_required: true,
                pending_event_ids: report.pending_event_ids,
                counts: report.counts,
                report,
            }));
            return EXIT_RECOVERY_REQUIRED;
        }
        writeStdout(io, envelope("status", {
            outcome: "ok",
            recovery_required: false,
            pending_event_ids: report.pending_event_ids,
            counts: report.counts,
            report,
        }));
        return EXIT_OK;
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("status", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        if (error instanceof JournalIntegrityError) {
            writeStdout(io, failure("status", DIAG.RECOVERY_REQUIRED));
            stderrFixed(io, stderrForOutcome(DIAG.RECOVERY_REQUIRED));
            return EXIT_RECOVERY_REQUIRED;
        }
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "status", error);
        }
        writeStdout(io, failure("status", DIAG.UNAVAILABLE));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
}
async function runSearch(io, requests) {
    let decoded;
    try {
        decoded = requests.map((request) => parseWithSchema(SearchRequestSchema, request, "search request"));
    }
    catch {
        writeStdout(io, failure("search", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("search", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    let services = null;
    for (const parsed of decoded) {
        try {
            services ??= await buildServices(stateRoot);
            const limit = parsed.limit ?? MAX_SEARCH_LIMIT;
            const result = await searchVault({
                config: services.config,
                query: parsed.query,
                limit,
                cache: services.searchCache,
            });
            writeStdout(io, envelope("search", {
                outcome: "ok",
                hits: result.hits,
                truncated: result.truncated,
                scanned_notes: result.scanned_notes,
                cache: result.cache,
            }));
        }
        catch (error) {
            if (error instanceof CliBootstrapError) {
                writeStdout(io, failure("search", DIAG.INVALID_CONFIG));
                stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
                return EXIT_INVALID;
            }
            if (error instanceof SearchError) {
                const invalid = error.code === "invalid_query";
                const outcome = invalid ? DIAG.INVALID_REQUEST : DIAG.UNAVAILABLE;
                writeStdout(io, failure("search", outcome));
                stderrFixed(io, stderrForOutcome(outcome));
                return invalid ? EXIT_INVALID : EXIT_UNAVAILABLE;
            }
            if (error instanceof ConfigError) {
                return writeConfigFailure(io, "search", error);
            }
            writeStdout(io, failure("search", DIAG.UNAVAILABLE));
            stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
            return EXIT_UNAVAILABLE;
        }
    }
    return EXIT_OK;
}
async function runRead(io, requests) {
    let decoded;
    try {
        decoded = requests.map((request) => parseWithSchema(ReadRequestSchema, request, "read request"));
    }
    catch {
        writeStdout(io, failure("read", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("read", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    let services = null;
    for (const parsed of decoded) {
        try {
            services ??= await buildServices(stateRoot);
            const result = await readVaultNote({
                config: services.config,
                path: parsed.path,
                ...(parsed.heading === undefined || parsed.heading === null
                    ? {}
                    : { heading: parsed.heading }),
            });
            writeStdout(io, envelope("read", {
                outcome: "ok",
                path: result.path,
                heading: result.heading,
                modified_at: result.modified_at,
                content: result.content,
                char_count: result.char_count,
                truncated: result.truncated,
            }));
        }
        catch (error) {
            if (error instanceof CliBootstrapError) {
                writeStdout(io, failure("read", DIAG.INVALID_CONFIG));
                stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
                return EXIT_INVALID;
            }
            if (error instanceof VaultReadError) {
                if (error.code === "note_unreadable") {
                    writeStdout(io, failure("read", DIAG.UNAVAILABLE));
                    stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
                    return EXIT_UNAVAILABLE;
                }
                writeStdout(io, failure("read", DIAG.INVALID_REQUEST));
                stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
                return EXIT_INVALID;
            }
            if (error instanceof ConfigError) {
                return writeConfigFailure(io, "read", error);
            }
            writeStdout(io, failure("read", DIAG.UNAVAILABLE));
            stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
            return EXIT_UNAVAILABLE;
        }
    }
    return EXIT_OK;
}
async function runBootstrap(io, requests) {
    let decoded;
    try {
        decoded = requests.map((request) => parseWithSchema(BootstrapRequestSchema, request, "bootstrap request"));
    }
    catch {
        writeStdout(io, failure("bootstrap", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("bootstrap", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    let services = null;
    for (const parsed of decoded) {
        try {
            services ??= await buildServices(stateRoot);
        }
        catch (error) {
            if (error instanceof CliBootstrapError) {
                writeStdout(io, failure("bootstrap", DIAG.INVALID_CONFIG));
                stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
                return EXIT_INVALID;
            }
            if (error instanceof ConfigError) {
                return writeConfigFailure(io, "bootstrap", error);
            }
            writeStdout(io, failure("bootstrap", DIAG.UNAVAILABLE));
            stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
            return EXIT_UNAVAILABLE;
        }
        const configuredBudget = services.config.budget.context_tokens;
        if (parsed.budget_tokens !== undefined && parsed.budget_tokens > configuredBudget) {
            writeStdout(io, failure("bootstrap", DIAG.INVALID_REQUEST));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
            return EXIT_INVALID;
        }
        const notes = {
            claude: parsed.notes.claude,
            current_daily: parsed.notes.current_daily,
            project: parsed.notes.project,
            ...(parsed.notes.moc === undefined ? {} : { moc: parsed.notes.moc }),
        };
        const result = buildBootstrap({
            notes,
            project: parsed.project,
            config: {
                budget_tokens: parsed.budget_tokens ?? configuredBudget,
                managed_headings: services.config.managed_headings,
            },
            estimateTokens: (context) => Math.ceil(Array.from(context).length / 4),
        });
        writeStdout(io, envelope("bootstrap", {
            outcome: "ok",
            version: result.version,
            context: result.context,
            truncated: result.truncated,
            estimated_tokens: result.estimated_tokens,
            budget_tokens: result.budget_tokens,
            fragments: result.fragments,
            project: result.project,
        }));
    }
    return EXIT_OK;
}
function applyEventId(idempotencyKey) {
    // Apply event id is derived from the validated normalized idempotency key.
    // The first 32 hex chars of the canonical SHA-256 are bounded and stable.
    const prefix = idempotencyKey.slice(0, 32);
    return parseWithSchema(EventIdSchema, `apply-${prefix}`, "apply event id");
}
function applyOutcomeEnvelope(outcome) {
    switch (outcome.kind) {
        case "applied":
            return envelope("checkpoint", {
                outcome: "applied",
                event_id: String(outcome.event_id),
                idempotency_key: String(outcome.receipt.idempotency_key),
                targets: outcome.receipt.targets.map((target) => ({
                    path: String(target.path),
                    before_hash: target.before_hash === null ? null : String(target.before_hash),
                    after_hash: String(target.after_hash),
                })),
            });
        case "already_applied":
            return envelope("checkpoint", {
                outcome: "already_applied",
                event_id: String(outcome.original_event_id),
                idempotency_key: String(outcome.idempotency_key),
                target_event_id: String(outcome.original_event_id),
            });
        case "deferred_conflict":
            return envelope("checkpoint", {
                outcome: "deferred",
                event_id: String(outcome.event_id),
                idempotency_key: String(outcome.receipt.idempotency_key),
                reason: outcome.receipt.outcome,
                proposal_path: outcome.receipt.proposal_path,
                conflict_paths: outcome.receipt.conflict_paths,
            });
        case "failed":
            return envelope("checkpoint", {
                outcome: "failed",
                event_id: String(outcome.event_id),
                idempotency_key: String(outcome.receipt.idempotency_key),
                reason: outcome.receipt.reason,
            });
        case "noop":
            return envelope("checkpoint", {
                outcome: "noop",
                event_id: String(outcome.event_id),
                idempotency_key: String(outcome.receipt.idempotency_key),
            });
        case "invalid":
            return envelope("checkpoint", { outcome: "invalid" });
    }
}
function applyOutcomeExit(outcome) {
    switch (outcome.kind) {
        case "applied":
        case "already_applied":
        case "noop":
            return EXIT_OK;
        case "deferred_conflict":
            return EXIT_DEFERRED;
        case "failed":
            switch (outcome.receipt.reason) {
                case "lock_unavailable":
                case "io_error":
                    return EXIT_UNAVAILABLE;
                case "precondition_mismatch":
                case "invalid_state":
                    return EXIT_RECOVERY_REQUIRED;
            }
            return EXIT_RECOVERY_REQUIRED;
        case "invalid":
            return EXIT_INVALID;
    }
}
async function runCheckpoint(io, requests, options) {
    if (!options.dryRun && !options.apply) {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    if (options.dryRun && options.apply) {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    if (requests.length !== 1) {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    const request = requests[0];
    // Dispatch on `kind` first so each branch owns a single exact schema.
    const record = typeof request === "object" && request !== null && !Array.isArray(request)
        ? request
        : null;
    const inner = record !== null && typeof record.checkpoint === "object" &&
        record.checkpoint !== null && !Array.isArray(record.checkpoint)
        ? record.checkpoint
        : null;
    const kind = inner !== null ? inner.kind : undefined;
    if (kind === "noop") {
        let noop;
        try {
            noop = parseWithSchema(CheckpointNoopRequestSchema, request, "checkpoint request");
        }
        catch {
            writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
            return EXIT_INVALID;
        }
        writeStdout(io, envelope("checkpoint", {
            outcome: "noop",
            reason: noop.checkpoint.reason,
        }));
        return EXIT_OK;
    }
    if (kind !== "apply") {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    let apply;
    try {
        apply = parseWithSchema(CheckpointApplyRequestSchema, request, "checkpoint request");
    }
    catch {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    if (!validCalendarDate(apply.date)) {
        writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("checkpoint", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    let services;
    try {
        services = await buildServices(stateRoot);
    }
    catch (error) {
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "checkpoint", error);
        }
        writeStdout(io, failure("checkpoint", DIAG.UNAVAILABLE));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
    try {
        const applyCheckpoint = apply.checkpoint;
        const projectResolution = apply.project;
        const projectTitle = apply.project_title;
        const snapshots = apply.snapshots;
        const templateSource = apply.template_source;
        const date = apply.date;
        const normalized = normalizeCheckpoint(applyCheckpoint, projectResolution);
        if (normalized.kind === "invalid") {
            writeStdout(io, failure("checkpoint", DIAG.INVALID_REQUEST));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
            return EXIT_INVALID;
        }
        if (normalized.kind === "noop") {
            writeStdout(io, envelope("checkpoint", {
                outcome: "noop",
                reason: normalized.reason,
            }));
            return EXIT_OK;
        }
        const writePlan = buildWritePlans({
            checkpoint: applyCheckpoint,
            effective_targets: normalized.effective_targets,
            resolution: projectResolution,
            project_title: projectTitle,
            snapshots: snapshots,
            template_source: templateSource,
            config: {
                daily_dir: services.config.layout.daily_dir,
                managed_headings: services.config.managed_headings,
            },
            date: date,
        });
        if (writePlan.kind === "deferred") {
            writeStdout(io, envelope("checkpoint", {
                outcome: "deferred",
                reason: writePlan.reason,
                conflict_paths: writePlan.conflict_paths,
            }));
            return EXIT_DEFERRED;
        }
        if (writePlan.kind === "nothing") {
            writeStdout(io, envelope("checkpoint", { outcome: "noop" }));
            return EXIT_OK;
        }
        const eventId = applyEventId(normalized.idempotency_key);
        const idempotencyKey = parseWithSchema(IdempotencyKeySchema, normalized.idempotency_key, "checkpoint idempotency key");
        if (options.dryRun) {
            writeStdout(io, envelope("checkpoint", {
                outcome: "dry_run",
                event_id: String(eventId),
                idempotency_key: String(idempotencyKey),
                plans: writePlan.plans.map((plan) => ({
                    path: String(plan.path),
                    before_hash: plan.before_hash === null ? null : String(plan.before_hash),
                    after_hash: String(plan.after_hash),
                    reason: plan.reason,
                })),
            }));
            return EXIT_OK;
        }
        const outcome = await services.transaction.apply({
            checkpoint: applyCheckpoint,
            idempotency_key: idempotencyKey,
            event_id: eventId,
            plans: writePlan.plans,
        });
        writeStdout(io, applyOutcomeEnvelope(outcome));
        return applyOutcomeExit(outcome);
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("checkpoint", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        if (error instanceof JournalIntegrityError || error instanceof TransactionIntegrityError) {
            writeStdout(io, failure("checkpoint", DIAG.INVALID_STATE));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_STATE));
            return EXIT_RECOVERY_REQUIRED;
        }
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "checkpoint", error);
        }
        writeStdout(io, failure("checkpoint", DIAG.UNAVAILABLE));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
}
async function runRecover(io) {
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("recover", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    try {
        const services = await buildServices(stateRoot);
        const outcome = await services.recovery.recover();
        if (outcome.kind === "nothing_pending") {
            writeStdout(io, envelope("recover", { outcome: "nothing_pending" }));
            return EXIT_OK;
        }
        const failedIds = outcome.failed_event_ids;
        const deferredIds = outcome.deferred_event_ids;
        const completedIds = outcome.completed_event_ids;
        if (failedIds.length > 0) {
            writeStdout(io, envelope("recover", {
                outcome: DIAG.RECOVERY_REQUIRED,
                event_id: String(outcome.event_id),
                completed_event_ids: completedIds.map(String),
                deferred_event_ids: deferredIds.map(String),
                failed_event_ids: failedIds.map(String),
            }));
            return EXIT_RECOVERY_REQUIRED;
        }
        if (deferredIds.length > 0) {
            writeStdout(io, envelope("recover", {
                outcome: DIAG.DEFERRED,
                event_id: String(outcome.event_id),
                completed_event_ids: completedIds.map(String),
                deferred_event_ids: deferredIds.map(String),
                failed_event_ids: failedIds.map(String),
            }));
            return EXIT_DEFERRED;
        }
        writeStdout(io, envelope("recover", {
            outcome: "recovered",
            event_id: String(outcome.event_id),
            completed_event_ids: completedIds.map(String),
            deferred_event_ids: deferredIds.map(String),
            failed_event_ids: failedIds.map(String),
        }));
        return EXIT_OK;
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("recover", DIAG.INVALID_CONFIG));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        if (error instanceof JournalIntegrityError || error instanceof TransactionIntegrityError) {
            writeStdout(io, failure("recover", DIAG.INVALID_STATE));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_STATE));
            return EXIT_RECOVERY_REQUIRED;
        }
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "recover", error);
        }
        writeStdout(io, failure("recover", DIAG.UNAVAILABLE));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
}
async function runRollback(io, targetEventId) {
    let stateRoot;
    try {
        stateRoot = resolveStateRoot();
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("rollback", DIAG.INVALID_CONFIG, { target_event_id: targetEventId }));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        throw error;
    }
    let target;
    try {
        target = parseWithSchema(EventIdSchema, targetEventId, "rollback target event id");
    }
    catch {
        writeStdout(io, failure("rollback", DIAG.INVALID_REQUEST, { target_event_id: targetEventId }));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    // Derive deterministic rollback event id and idempotency key from the
    // canonical target event id. SHA-256(rollback:<target>) truncated.
    const digest = createHash("sha256")
        .update(`rollback:${targetEventId}`, "utf8")
        .digest("hex");
    let eventId;
    let idempotencyKey;
    try {
        eventId = parseWithSchema(EventIdSchema, `rollback-${digest.slice(0, 32)}`, "rollback event id");
        idempotencyKey = parseWithSchema(IdempotencyKeySchema, digest, "rollback idempotency key");
    }
    catch {
        writeStdout(io, failure("rollback", DIAG.INVALID_REQUEST, { target_event_id: targetEventId }));
        stderrFixed(io, stderrForOutcome(DIAG.INVALID_REQUEST));
        return EXIT_INVALID;
    }
    try {
        const services = await buildServices(stateRoot);
        const outcome = await services.rollback.rollback({
            target_event_id: target,
            event_id: eventId,
            idempotency_key: idempotencyKey,
        });
        if (outcome.kind === "rolled_back") {
            writeStdout(io, envelope("rollback", {
                outcome: "rolled_back",
                event_id: String(eventId),
                target_event_id: String(targetEventId),
                idempotency_key: String(idempotencyKey),
                rollback_targets: outcome.receipt.rollback_targets,
            }));
            return EXIT_OK;
        }
        if (outcome.kind === "already_rolled_back") {
            writeStdout(io, envelope("rollback", {
                outcome: "already_rolled_back",
                event_id: String(eventId),
                target_event_id: String(targetEventId),
                idempotency_key: String(idempotencyKey),
            }));
            return EXIT_OK;
        }
        // Rejected: not_applied => 2, precondition_mismatch OR missing_backup => 6,
        // invalid_state => 5.
        switch (outcome.reason) {
            case "not_applied":
                writeStdout(io, envelope("rollback", {
                    outcome: "not_applied",
                    target_event_id: String(targetEventId),
                }));
                return EXIT_INVALID;
            case "precondition_mismatch":
                writeStdout(io, envelope("rollback", {
                    outcome: "precondition_mismatch",
                    target_event_id: String(targetEventId),
                    mismatch_paths: outcome.mismatch_paths ?? [],
                }));
                return EXIT_ROLLBACK_PRECONDITION;
            case "missing_backup":
                writeStdout(io, envelope("rollback", {
                    outcome: "missing_backup",
                    target_event_id: String(targetEventId),
                }));
                return EXIT_ROLLBACK_PRECONDITION;
            case "invalid_state":
                writeStdout(io, failure("rollback", DIAG.INVALID_STATE, { target_event_id: String(targetEventId) }));
                return EXIT_RECOVERY_REQUIRED;
        }
    }
    catch (error) {
        if (error instanceof CliBootstrapError) {
            writeStdout(io, failure("rollback", DIAG.INVALID_CONFIG, { target_event_id: String(targetEventId) }));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_CONFIG));
            return EXIT_INVALID;
        }
        if (error instanceof JournalIntegrityError || error instanceof TransactionIntegrityError) {
            writeStdout(io, failure("rollback", DIAG.INVALID_STATE, { target_event_id: String(targetEventId) }));
            stderrFixed(io, stderrForOutcome(DIAG.INVALID_STATE));
            return EXIT_RECOVERY_REQUIRED;
        }
        if (error instanceof ConfigError) {
            return writeConfigFailure(io, "rollback", error);
        }
        writeStdout(io, failure("rollback", DIAG.UNAVAILABLE, { target_event_id: String(targetEventId) }));
        stderrFixed(io, stderrForOutcome(DIAG.UNAVAILABLE));
        return EXIT_UNAVAILABLE;
    }
    return EXIT_INVALID;
}
function runHelp(io) {
    writeStdout(io, envelope("help", { outcome: "ok", help: HELP_TEXT }));
    return EXIT_OK;
}
// ---------------------------------------------------------------------------
// Public entry point. Importing `runCli` does NOT install signal handlers,
// does NOT read stdin, and does NOT exit. Effects run only when invoked.
// ---------------------------------------------------------------------------
export async function runCli(io) {
    const parsedArgs = parseArgs(io.argv);
    if (!parsedArgs.ok) {
        const exit = parsedArgs.exit;
        const stderrMessage = parsedArgs.stderr;
        writeStdout(io, failure("help", DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrMessage);
        return exit;
    }
    const plan = parsedArgs.plan;
    const bodyless = isBodylessCommand(plan);
    const framing = await readFramedRequests(io, {
        requireBody: !bodyless,
    });
    if (!framing.ok) {
        const command = planCommandName(plan);
        const exit = framing.exit;
        const stderrMessage = framing.stderr;
        writeStdout(io, failure(command, DIAG.INVALID_REQUEST));
        stderrFixed(io, stderrMessage);
        return exit;
    }
    // Bodyless commands reject nonempty piped bodies.
    if (bodyless && framing.lines.length > 0) {
        const command = planCommandName(plan);
        writeStdout(io, failure(command, DIAG.INVALID_REQUEST));
        stderrFixed(io, FIXED_STDERR.bodyless_command_with_body);
        return EXIT_INVALID;
    }
    // Bounds on JSONL request count (search/read/bootstrap only).
    if ((plan.kind === "search" ||
        plan.kind === "read" ||
        plan.kind === "bootstrap") &&
        (framing.lines.length < MIN_FRAME_REQUESTS ||
            framing.lines.length > MAX_FRAME_REQUESTS)) {
        const command = planCommandName(plan);
        writeStdout(io, failure(command, DIAG.INVALID_REQUEST));
        stderrFixed(io, FIXED_STDERR.too_many_requests);
        return EXIT_INVALID;
    }
    switch (plan.kind) {
        case "doctor":
            return runDoctor(io, plan);
        case "status":
            return runStatus(io);
        case "search":
            return runSearch(io, framing.lines);
        case "read":
            return runRead(io, framing.lines);
        case "bootstrap":
            return runBootstrap(io, framing.lines);
        case "checkpoint":
            return runCheckpoint(io, framing.lines, {
                dryRun: plan.dryRun,
                apply: plan.apply,
            });
        case "recover":
            return runRecover(io);
        case "rollback":
            return runRollback(io, plan.eventId);
        case "help":
            return runHelp(io);
    }
}
// ---------------------------------------------------------------------------
// Main entry point. The SIGINT handler and process.exit live ONLY here and
// only when this module is the executable's entry (i.e. argv[1] is this
// file). Importing the module is side-effect free.
// ---------------------------------------------------------------------------
function isExecutableEntry() {
    const argv1 = process.argv[1];
    if (argv1 === undefined)
        return false;
    try {
        return import.meta.url === pathToFileURL(argv1).href;
    }
    catch {
        return false;
    }
}
async function main() {
    // SIGINT handler installed only in the executable entry. There is no
    // partial stdout to flush because stdin is read fully before any stdout.
    process.on("SIGINT", () => {
        process.exit(EXIT_SIGINT);
    });
    const io = {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        argv: process.argv.slice(2),
        stdinIsTTY: Boolean(process.stdin.isTTY),
    };
    return runCli(io);
}
if (isExecutableEntry()) {
    void main().then((code) => {
        // Normal completion sets the exit code; only the SIGINT handler
        // calls process.exit(EXIT_SIGINT).
        process.exitCode = code;
    }, () => {
        process.exitCode = EXIT_UNAVAILABLE;
    });
}
