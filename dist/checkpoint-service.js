/** Core checkpoint facade shared by host adapters. */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import { normalizeCheckpoint } from "./checkpoint.js";
import { JournalStore } from "./journal.js";
import { parseNote } from "./markdown.js";
import { VaultPathError, VaultPaths, nodeVaultPathsFs } from "./paths.js";
import { buildAssociationProposal, resolveProjectWithCandidates, } from "./project.js";
import { buildWritePlans } from "./render.js";
import { CwdSchema, EventIdSchema, HashHexSchema, IdempotencyKeySchema, IsoTimestampSchema, ProjectResolutionSchema, SessionIdSchema, VaultPathSchema, parseWithSchema, } from "./schemas.js";
import { nodeSnapshotFs, readSnapshotFile, } from "./snapshot.js";
import { MissingProgressError, TransactionService } from "./transaction.js";
import { CheckpointCommandSchema, } from "./checkpoint-contract.js";
const MAX_SNAPSHOT_BYTES = 1_000_000;
const MOC_RELATIVE_PATH = "MOC — Inicio.md";
const CLAUDE_RELATIVE_PATH = "CLAUDE.md";
const UNRESOLVED_PROJECT_ID = "unresolved";
const TrustedCheckpointContextSchema = Type.Object({ cwd: CwdSchema, session_id: SessionIdSchema }, { additionalProperties: false });
function validateTrusted(value) {
    const parsed = parseWithSchema(TrustedCheckpointContextSchema, value, "trusted checkpoint context");
    if (!path.isAbsolute(parsed.cwd) || Buffer.byteLength(parsed.cwd, "utf8") > 4_096) {
        throw new Error("trusted checkpoint context is invalid");
    }
    return parsed;
}
function configRoot(deps) {
    const explicit = deps.xdgConfigHome;
    if (explicit !== undefined) {
        if (explicit.length === 0 || !path.isAbsolute(explicit))
            throw new Error("configuration unavailable");
        return path.resolve(explicit);
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg !== undefined) {
        if (xdg.length === 0 || !path.isAbsolute(xdg))
            throw new Error("configuration unavailable");
        return path.resolve(xdg);
    }
    const home = deps.home ?? process.env.HOME ?? os.homedir();
    if (home.length === 0 || !path.isAbsolute(home))
        throw new Error("configuration unavailable");
    return path.resolve(home, ".config");
}
function stateRoot(deps) {
    const explicit = deps.xdgStateHome ?? process.env.XDG_STATE_HOME;
    if (explicit !== undefined) {
        if (explicit.length === 0 || !path.isAbsolute(explicit) || path.parse(explicit).root === path.resolve(explicit)) {
            throw new Error("checkpoint state unavailable");
        }
        return path.resolve(explicit);
    }
    const home = deps.home ?? process.env.HOME ?? os.homedir();
    if (home.length === 0 || !path.isAbsolute(home))
        throw new Error("checkpoint state unavailable");
    return path.resolve(home, ".local", "state");
}
async function loadCheckpointConfig(deps) {
    return await loadConfig({
        ...(deps.configFs === undefined ? {} : { fs: deps.configFs }),
        xdgConfigHome: configRoot(deps),
    });
}
function timestamp(deps) {
    return parseWithSchema(IsoTimestampSchema, deps.now?.().toISOString() ?? new Date().toISOString(), "checkpoint timestamp");
}
function eventId(key, prefix) {
    return parseWithSchema(EventIdSchema, `${prefix}-${key.slice(0, 32)}`, "checkpoint event id");
}
function sessionNoopKey(key, sessionId) {
    return parseWithSchema(IdempotencyKeySchema, createHash("sha256")
        .update("prime-agent-noop\0", "utf8")
        .update(sessionId, "utf8")
        .update("\0", "utf8")
        .update(key, "utf8")
        .digest("hex"), "checkpoint noop idempotency key");
}
function resultFromCore(value) {
    switch (value.kind) {
        case "invalid": return { outcome: "invalid" };
        case "applied": return { outcome: "applied" };
        case "noop": return { outcome: "noop" };
        case "deferred_conflict": return { outcome: "deferred" };
        case "failed": return { outcome: "failed" };
        case "already_applied": return { outcome: "already_applied" };
    }
}
function resultFromReceipt(receipt) {
    switch (receipt.outcome) {
        case "applied": return { outcome: "already_applied" };
        case "noop": return { outcome: "noop" };
        case "deferred_conflict": return { outcome: "deferred" };
        case "failed": return { outcome: "failed" };
        case "rolled_back": throw new Error("checkpoint receipt unavailable");
    }
}
async function existingCheckpointResult(journal, key) {
    const existing = await journal.findReceiptByIdempotency(key);
    return existing === null ? null : resultFromReceipt(existing.receipt);
}
function projectTitle(snapshot) {
    if (snapshot === null)
        return null;
    const note = parseNote(snapshot.source);
    if (note.frontmatter.kind === "present" && note.frontmatter.metadata.title !== null) {
        return note.frontmatter.metadata.title;
    }
    return note.headings.find((heading) => heading.level === 1)?.text ?? null;
}
function dailyPath(dailyDir, now) {
    return `${dailyDir}/${now.slice(0, 10)}.md`;
}
async function readOptional(vaultPaths, snapshotFs, trustedRoot, relative) {
    let resolved;
    try {
        resolved = await vaultPaths.resolveRead(relative, { automatic: false });
    }
    catch (error) {
        if (error instanceof VaultPathError && error.code === "target_missing")
            return null;
        throw error;
    }
    return await readSnapshotFile(snapshotFs, vaultPaths, trustedRoot, resolved, MAX_SNAPSHOT_BYTES);
}
async function readRequired(vaultPaths, snapshotFs, trustedRoot, relative) {
    const resolved = await vaultPaths.resolveRead(relative, { automatic: false });
    return await readSnapshotFile(snapshotFs, vaultPaths, trustedRoot, resolved, MAX_SNAPSHOT_BYTES);
}
function associationText(proposal) {
    const data = {
        version: proposal.version,
        kind: proposal.kind,
        resolution: proposal.resolution,
        candidates: proposal.candidates,
        daily_write_only: proposal.daily_write_only,
        created_at: proposal.created_at,
    };
    return `# Resyst Vault Bridge — pending association\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
}
function contentHash(content) {
    return parseWithSchema(HashHexSchema, createHash("sha256").update(content, "utf8").digest("hex"), "association proposal hash");
}
async function associationPlan(resolution, lexicalCandidates, now, event, inboxDir, vaultPaths, snapshotFs, trustedRoot) {
    const proposal = buildAssociationProposal(resolution, now, lexicalCandidates.map((candidate) => candidate.path));
    if (proposal === null)
        throw new Error("association proposal unavailable");
    const relative = parseWithSchema(VaultPathSchema, `${inboxDir}/resyst-association-${event}.md`, "association proposal path");
    const prior = await readOptional(vaultPaths, snapshotFs, trustedRoot, relative);
    const content = associationText(proposal);
    if (prior !== null && prior.source !== content) {
        throw new Error("association proposal conflict");
    }
    return {
        path: relative,
        before_hash: prior === null ? null : contentHash(prior.source),
        after_content: content,
        after_hash: contentHash(content),
        reason: "association_proposal",
    };
}
async function checkpointOnce(input, deps) {
    const command = parseWithSchema(CheckpointCommandSchema, input.command, "checkpoint command");
    const trusted = validateTrusted(input.trusted);
    const config = await loadCheckpointConfig(deps);
    const now = timestamp(deps);
    const journal = deps.journal ?? new JournalStore({
        vaultRoot: config.vault_path,
        identity: config.vault_identity,
        now: () => now,
    });
    const transaction = deps.transaction ?? new TransactionService({
        vaultRoot: config.vault_path,
        stateRoot: stateRoot(deps),
        journal,
        config,
        now: () => now,
    });
    if (command.kind === "noop") {
        const normalized = normalizeCheckpoint(command, { kind: "unresolved", reason: "no_match" });
        if (normalized.kind !== "noop")
            throw new Error("noop normalization failed");
        const key = sessionNoopKey(normalized.idempotency_key, trusted.session_id);
        return resultFromCore(await transaction.recordNoop({
            checkpoint: normalized.checkpoint,
            idempotency_key: key,
            event_id: eventId(key, "noop"),
        }));
    }
    const resolutionOutcome = await resolveProjectWithCandidates({
        cwd: trusted.cwd,
        config,
        ...(deps.projectFs === undefined ? {} : { fs: deps.projectFs }),
        ...(deps.git === undefined ? {} : { git: deps.git }),
        ...(deps.execFile === undefined ? {} : { execFile: deps.execFile }),
    });
    const resolution = parseWithSchema(ProjectResolutionSchema, resolutionOutcome.resolution, "checkpoint project resolution");
    const source = {
        agent: "prime-agent",
        host_id: config.host_id,
        session_id: trusted.session_id,
        cwd: trusted.cwd,
    };
    const projectId = resolution.kind === "resolved" ? resolution.project_id : UNRESOLVED_PROJECT_ID;
    const normalized = normalizeCheckpoint({ ...command, source, project: { id: projectId } }, resolution);
    if (normalized.kind !== "apply")
        return { outcome: "invalid" };
    const key = parseWithSchema(IdempotencyKeySchema, normalized.idempotency_key, "checkpoint key");
    const existing = await existingCheckpointResult(journal, key);
    if (existing !== null)
        return existing;
    const priorEvent = await journal.findEventByIdempotency(key);
    if (priorEvent !== null) {
        if (priorEvent.kind !== "apply")
            throw new Error("checkpoint event unavailable");
        try {
            return resultFromCore(await transaction.recoverEvent(priorEvent));
        }
        catch (error) {
            if (!(error instanceof MissingProgressError))
                throw error;
            // Prepare-all-before-rename guarantees a missing progress record means
            // no durable target rename has begun; deterministic rendering may safely
            // rebuild the still-missing preparation frontier below.
        }
    }
    const event = eventId(key, "apply");
    const vaultPaths = new VaultPaths(config.vault_path, {
        identity: config.vault_identity,
        attachmentsDir: config.layout.attachments_dir,
        fs: deps.vaultPathsFs ?? nodeVaultPathsFs,
    });
    const snapshotFs = deps.snapshotFs ?? nodeSnapshotFs;
    const trustedRoot = config.vault_identity.real_path;
    const daily = normalized.effective_targets.daily
        ? await readOptional(vaultPaths, snapshotFs, trustedRoot, dailyPath(config.layout.daily_dir, now))
        : null;
    const template = normalized.effective_targets.daily && daily === null && config.templates.daily !== null
        ? await readRequired(vaultPaths, snapshotFs, trustedRoot, config.templates.daily)
        : null;
    const project = resolution.kind === "resolved" && resolution.note_path !== null &&
        (normalized.effective_targets.project || normalized.effective_targets.landscape)
        ? await readRequired(vaultPaths, snapshotFs, trustedRoot, resolution.note_path)
        : null;
    const claude = normalized.effective_targets.landscape
        ? await readRequired(vaultPaths, snapshotFs, trustedRoot, CLAUDE_RELATIVE_PATH)
        : null;
    const moc = normalized.effective_targets.landscape
        ? await readRequired(vaultPaths, snapshotFs, trustedRoot, MOC_RELATIVE_PATH)
        : null;
    const snapshots = {
        daily: daily?.source ?? null,
        project: project?.source ?? null,
        moc: moc?.source ?? null,
        claude: claude?.source ?? null,
    };
    const rendered = buildWritePlans({
        checkpoint: normalized.checkpoint,
        effective_targets: normalized.effective_targets,
        resolution,
        project_title: projectTitle(project),
        snapshots,
        template_source: template?.source ?? null,
        config: { daily_dir: config.layout.daily_dir, managed_headings: config.managed_headings },
        date: now.slice(0, 10),
    });
    if (rendered.kind === "deferred")
        return { outcome: "deferred" };
    const plans = rendered.kind === "plan" ? [...rendered.plans] : [];
    if (resolution.kind !== "resolved") {
        plans.push(await associationPlan(resolution, resolutionOutcome.lexical_candidates, now, event, config.layout.inbox_dir, vaultPaths, snapshotFs, trustedRoot));
    }
    if (plans.length === 0) {
        const concurrent = await existingCheckpointResult(journal, key);
        if (concurrent !== null)
            return concurrent;
        if (priorEvent !== null)
            throw new Error("checkpoint recovery pending");
        return resultFromCore(await transaction.recordNoop({
            checkpoint: { version: 1, kind: "noop", reason: "no_new_knowledge" },
            idempotency_key: key,
            event_id: eventId(key, "noop"),
        }));
    }
    return resultFromCore(await transaction.apply({
        checkpoint: normalized.checkpoint,
        idempotency_key: key,
        event_id: event,
        plans,
    }));
}
export function createProductionCheckpointService(deps = {}) {
    return { checkpoint: (input) => checkpointOnce(input, deps) };
}
