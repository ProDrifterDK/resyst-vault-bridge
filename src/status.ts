/** Read-only status and health diagnostics with redacted output. */
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import type { BridgeConfig } from "./config.js";
import type { JournalStore } from "./journal.js";
import type { LocalLock } from "./lock.js";
import { findHeading } from "./markdown.js";
import type { VaultPaths } from "./paths.js";
import { IsoTimestampSchema, parseWithSchema } from "./schemas.js";
import type { SearchCacheStore } from "./search.js";
import type { EventId, IsoTimestamp, VaultPath } from "./types.js";

export interface StatusCounts { pending: number; deferred: number; applied: number; rolled_back: number; failed: number; noop: number; }
export interface StatusReport { version: 1; generated_at: IsoTimestamp; counts: StatusCounts; recovery_required: boolean; pending_event_ids: EventId[]; deferred: Array<{ event_id: EventId; proposal_path: VaultPath; conflict_paths: VaultPath[] }>; }
export type DoctorCheck =
  | { id: "vault_permissions"; status: "ok" | "error" }
  | { id: "template"; status: "ok" | "builtin" | "missing" | "unreadable" }
  | { id: "template_headings"; status: "ok" | "missing_headings"; missing: string[] }
  | { id: "lock"; status: "free" | "held_live" | "abandoned" | "unknown" | "corrupt"; cleanable: boolean }
  | { id: "syncthing_conflicts"; status: "ok" | "conflicts"; paths: VaultPath[]; truncated: boolean }
  | { id: "cache"; status: "ok" | "missing" | "corrupt" }
  | { id: "journal"; status: "ok" | "integrity_error" }
  | { id: "pending_events"; status: "none" | "pending"; event_ids: EventId[] };
export interface DoctorReport { version: 1; generated_at: IsoTimestamp; overall: "ok" | "warnings" | "errors"; checks: DoctorCheck[]; }
function time(now: () => string): IsoTimestamp { return parseWithSchema(IsoTimestampSchema, now(), "status timestamp"); }

export class StatusService {
  constructor(private readonly options: { journal: JournalStore; now?: () => string }) {}
  async report(): Promise<StatusReport> {
    const [events, receipts] = await Promise.all([this.options.journal.listEvents(), this.options.journal.listReceipts()]);
    const receiptByEvent = new Map(receipts.map((receipt) => [receipt.event_id, receipt]));
    const rolledTargets = new Set(receipts.filter((receipt) => receipt.outcome === "rolled_back").map((receipt) => receipt.target_event_id));
    const counts: StatusCounts = { pending: 0, deferred: 0, applied: 0, rolled_back: 0, failed: 0, noop: 0 };
    const pending: EventId[] = []; const deferred: StatusReport["deferred"] = [];
    for (const event of events) {
      if (event.kind === "recover") continue;
      const receipt = receiptByEvent.get(event.event_id);
      if (event.kind === "rollback") {
        if (receipt === undefined) { counts.pending += 1; pending.push(event.event_id); }
        continue;
      }
      if (event.kind === "apply" && rolledTargets.has(event.event_id)) { counts.rolled_back += 1; continue; }
      if (receipt === undefined) { if (event.kind === "apply") { counts.pending += 1; pending.push(event.event_id); } else if (event.kind === "deferred") counts.deferred += 1; continue; }
      switch (receipt.outcome) {
        case "applied": counts.applied += 1; break;
        case "deferred_conflict": counts.deferred += 1; deferred.push({ event_id: event.event_id, proposal_path: receipt.proposal_path, conflict_paths: [...receipt.conflict_paths].sort() }); break;
        case "failed": counts.failed += 1; break;
        case "noop": counts.noop += 1; break;
        case "rolled_back": break;
      }
    }
    return { version: 1, generated_at: time(this.options.now ?? (() => new Date().toISOString())), counts, recovery_required: counts.pending > 0, pending_event_ids: pending.sort(), deferred: deferred.sort((left, right) => String(left.event_id).localeCompare(String(right.event_id))) };
  }
}

export interface DoctorServiceOptions { config: BridgeConfig; journal: JournalStore; lock: LocalLock; paths: VaultPaths; cache: SearchCacheStore; now?: () => string; }
export class DoctorService {
  private readonly now: () => string;
  constructor(private readonly options: DoctorServiceOptions) { this.now = options.now ?? (() => new Date().toISOString()); }
  private async permissions(): Promise<DoctorCheck> { try { for (const directory of [this.options.config.layout.daily_dir, this.options.config.layout.projects_dir, this.options.config.layout.inbox_dir, this.options.config.layout.templates_dir]) { const resolved = await this.options.paths.resolveDirectory(directory); const stat = await lstat(resolved.absolute); if ((stat.mode & 0o444) === 0) throw new Error("unreadable"); await access(resolved.absolute, fsConstants.R_OK); } return { id: "vault_permissions", status: "ok" }; } catch { return { id: "vault_permissions", status: "error" }; } }
  private async template(): Promise<DoctorCheck[]> {
    const configured = this.options.config.templates.daily;
    if (configured === null) return [{ id: "template", status: "builtin" }, { id: "template_headings", status: "ok", missing: [] }];
    let source: string;
    try { const resolved = await this.options.paths.resolveRead(configured); source = await readFile(resolved.absolute, "utf8"); } catch { return [{ id: "template", status: "missing" }, { id: "template_headings", status: "missing_headings", missing: Object.values(this.options.config.managed_headings) }]; }
    const missing = Object.values(this.options.config.managed_headings).filter((heading) => findHeading(source, heading).kind !== "found");
    return [{ id: "template", status: "ok" }, { id: "template_headings", status: missing.length === 0 ? "ok" : "missing_headings", missing }];
  }
  private async conflicts(): Promise<Extract<DoctorCheck, { id: "syncthing_conflicts" }>> {
    const found: VaultPath[] = []; let truncated = false;
    for (const relative of [this.options.config.layout.daily_dir, this.options.config.layout.projects_dir]) {
      try { const directory = await this.options.paths.resolveDirectory(relative); for (const name of (await readdir(directory.absolute)).sort()) { if (!/\.sync-conflict-.*\.md$/iu.test(name)) continue; if (found.length >= 64) { truncated = true; break; } found.push(`${relative}/${name}` as VaultPath); } } catch { continue; }
    }
    return { id: "syncthing_conflicts", status: found.length === 0 ? "ok" : "conflicts", paths: found, truncated };
  }
  async check(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [await this.permissions(), ...await this.template()];
    let status: StatusReport | null = null;
    try { status = await new StatusService({ journal: this.options.journal, now: this.now }).report(); checks.push({ id: "journal", status: "ok" }); } catch { checks.push({ id: "journal", status: "integrity_error" }); }
    checks.push({ id: "pending_events", status: status?.recovery_required ? "pending" : "none", event_ids: status?.pending_event_ids ?? [] });
    try { const inspected = await this.options.lock.inspect(); checks.push(inspected.kind === "free" ? { id: "lock", status: "free", cleanable: false } : { id: "lock", status: inspected.liveness === "live" ? "held_live" : inspected.liveness === "dead" ? "abandoned" : "unknown", cleanable: inspected.liveness === "dead" }); } catch { checks.push({ id: "lock", status: "corrupt", cleanable: false }); }
    checks.push(await this.conflicts());
    try { const cached = await this.options.cache.read(); if (cached === null) checks.push({ id: "cache", status: "missing" }); else { const value = typeof cached === "string" ? JSON.parse(cached) as unknown : cached; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bad cache"); checks.push({ id: "cache", status: "ok" }); } } catch { checks.push({ id: "cache", status: "corrupt" }); }
    const errors = checks.some((check) => (check.id === "vault_permissions" && check.status === "error") || (check.id === "journal" && check.status === "integrity_error"));
    const warnings = checks.some((check) => check.status !== "ok" && check.status !== "free" && check.status !== "none" && check.status !== "builtin");
    return { version: 1, generated_at: time(this.now), overall: errors ? "errors" : warnings ? "warnings" : "ok", checks };
  }
  cleanAbandonedLock(): ReturnType<LocalLock["removeAbandoned"]> { return this.options.lock.removeAbandoned(); }
}
