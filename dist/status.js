/** Read-only status and health diagnostics with redacted output. */
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { findHeading } from "./markdown.js";
import { IsoTimestampSchema, parseWithSchema } from "./schemas.js";
function time(now) { return parseWithSchema(IsoTimestampSchema, now(), "status timestamp"); }
export class StatusService {
    options;
    constructor(options) {
        this.options = options;
    }
    async report() {
        const [events, receipts] = await Promise.all([this.options.journal.listEvents(), this.options.journal.listReceipts()]);
        const receiptByEvent = new Map(receipts.map((receipt) => [receipt.event_id, receipt]));
        const rolledTargets = new Set(receipts.filter((receipt) => receipt.outcome === "rolled_back").map((receipt) => receipt.target_event_id));
        const counts = { pending: 0, deferred: 0, applied: 0, rolled_back: 0, failed: 0, noop: 0 };
        const pending = [];
        const deferred = [];
        for (const event of events) {
            if (event.kind === "recover")
                continue;
            const receipt = receiptByEvent.get(event.event_id);
            if (event.kind === "rollback") {
                if (receipt === undefined) {
                    counts.pending += 1;
                    pending.push(event.event_id);
                }
                continue;
            }
            if (event.kind === "apply" && rolledTargets.has(event.event_id)) {
                counts.rolled_back += 1;
                continue;
            }
            if (receipt === undefined) {
                if (event.kind === "apply") {
                    counts.pending += 1;
                    pending.push(event.event_id);
                }
                else if (event.kind === "deferred")
                    counts.deferred += 1;
                continue;
            }
            switch (receipt.outcome) {
                case "applied":
                    counts.applied += 1;
                    break;
                case "deferred_conflict":
                    counts.deferred += 1;
                    deferred.push({ event_id: event.event_id, proposal_path: receipt.proposal_path, conflict_paths: [...receipt.conflict_paths].sort() });
                    break;
                case "failed":
                    counts.failed += 1;
                    break;
                case "noop":
                    counts.noop += 1;
                    break;
                case "rolled_back": break;
            }
        }
        return { version: 1, generated_at: time(this.options.now ?? (() => new Date().toISOString())), counts, recovery_required: counts.pending > 0, pending_event_ids: pending.sort(), deferred: deferred.sort((left, right) => String(left.event_id).localeCompare(String(right.event_id))) };
    }
}
export class DoctorService {
    options;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
    }
    async permissions() { try {
        for (const directory of [this.options.config.layout.daily_dir, this.options.config.layout.projects_dir, this.options.config.layout.inbox_dir, this.options.config.layout.templates_dir]) {
            const resolved = await this.options.paths.resolveDirectory(directory);
            const stat = await lstat(resolved.absolute);
            if ((stat.mode & 0o444) === 0)
                throw new Error("unreadable");
            await access(resolved.absolute, fsConstants.R_OK);
        }
        return { id: "vault_permissions", status: "ok" };
    }
    catch {
        return { id: "vault_permissions", status: "error" };
    } }
    async template() {
        const configured = this.options.config.templates.daily;
        if (configured === null)
            return [{ id: "template", status: "builtin" }, { id: "template_headings", status: "ok", missing: [] }];
        let source;
        try {
            const resolved = await this.options.paths.resolveRead(configured);
            source = await readFile(resolved.absolute, "utf8");
        }
        catch {
            return [{ id: "template", status: "missing" }, { id: "template_headings", status: "missing_headings", missing: Object.values(this.options.config.managed_headings) }];
        }
        const missing = Object.values(this.options.config.managed_headings).filter((heading) => findHeading(source, heading).kind !== "found");
        return [{ id: "template", status: "ok" }, { id: "template_headings", status: missing.length === 0 ? "ok" : "missing_headings", missing }];
    }
    async conflicts() {
        const found = [];
        let truncated = false;
        for (const relative of [this.options.config.layout.daily_dir, this.options.config.layout.projects_dir]) {
            try {
                const directory = await this.options.paths.resolveDirectory(relative);
                for (const name of (await readdir(directory.absolute)).sort()) {
                    if (!/\.sync-conflict-.*\.md$/iu.test(name))
                        continue;
                    if (found.length >= 64) {
                        truncated = true;
                        break;
                    }
                    found.push(`${relative}/${name}`);
                }
            }
            catch {
                continue;
            }
        }
        return { id: "syncthing_conflicts", status: found.length === 0 ? "ok" : "conflicts", paths: found, truncated };
    }
    async check() {
        const checks = [await this.permissions(), ...await this.template()];
        let status = null;
        try {
            status = await new StatusService({ journal: this.options.journal, now: this.now }).report();
            checks.push({ id: "journal", status: "ok" });
        }
        catch {
            checks.push({ id: "journal", status: "integrity_error" });
        }
        checks.push({ id: "pending_events", status: status?.recovery_required ? "pending" : "none", event_ids: status?.pending_event_ids ?? [] });
        try {
            const inspected = await this.options.lock.inspect();
            checks.push(inspected.kind === "free" ? { id: "lock", status: "free", cleanable: false } : { id: "lock", status: inspected.liveness === "live" ? "held_live" : inspected.liveness === "dead" ? "abandoned" : "unknown", cleanable: inspected.liveness === "dead" });
        }
        catch {
            checks.push({ id: "lock", status: "corrupt", cleanable: false });
        }
        checks.push(await this.conflicts());
        try {
            const cached = await this.options.cache.read();
            if (cached === null)
                checks.push({ id: "cache", status: "missing" });
            else {
                const value = typeof cached === "string" ? JSON.parse(cached) : cached;
                if (typeof value !== "object" || value === null || Array.isArray(value))
                    throw new Error("bad cache");
                checks.push({ id: "cache", status: "ok" });
            }
        }
        catch {
            checks.push({ id: "cache", status: "corrupt" });
        }
        const errors = checks.some((check) => (check.id === "vault_permissions" && check.status === "error") || (check.id === "journal" && check.status === "integrity_error"));
        const warnings = checks.some((check) => check.status !== "ok" && check.status !== "free" && check.status !== "none" && check.status !== "builtin");
        return { version: 1, generated_at: time(this.now), overall: errors ? "errors" : warnings ? "warnings" : "ok", checks };
    }
    cleanAbandonedLock() { return this.options.lock.removeAbandoned(); }
}
