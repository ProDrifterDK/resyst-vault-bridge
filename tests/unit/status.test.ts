import { chmod, lstat, mkdir, mkdtemp, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalStore } from "../../src/journal.js";
import { LocalLock } from "../../src/lock.js";
import { VaultPaths, type VaultRootIdentity } from "../../src/paths.js";
import { DoctorService, StatusService } from "../../src/status.js";
import type { BridgeConfig } from "../../src/config.js";
import type { ApplyCheckpoint, EvidenceId, HostId, ProjectId, SessionId, VaultPath } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function checkpoint(): ApplyCheckpoint { return {
  version: 1, kind: "apply", source: { agent: "prime-agent", host_id: "casey" as HostId, session_id: "session-atlas" as SessionId, cwd: "/home/tester/synthetic/atlas" },
  project: { id: "atlas" as ProjectId }, knowledge: { completed_tasks: [{ text: "Status fixture", evidence: ["status-test" as EvidenceId] }], decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [] },
  evidence: { commits: [], tests: [{ id: "status-test" as EvidenceId, value: "status unit" }], files: [], deployments: [], observations: [] }, targets: { daily: true, project: false, landscape: false },
}; }

async function context(): Promise<{ root: string; stateRoot: string; config: BridgeConfig; identity: VaultRootIdentity; journal: JournalStore; paths: VaultPaths }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-status-")); roots.push(root);
  await createVault({ vaultPath: root, withDailyNote: true, withProjectNote: true });
  const s = await stat(root, { bigint: true });
  const identity: VaultRootIdentity = { real_path: await realpath(root), dev: s.dev, ino: s.ino };
  const stateRoot = `${root}-state`; roots.push(stateRoot); await mkdir(stateRoot, { recursive: true });
  const config: BridgeConfig = { version: 1, host_id: "casey" as HostId, vault_path: root, vault_identity: identity,
    layout: { daily_dir: "Notas Diarias", projects_dir: "Proyectos", inbox_dir: "Inbox", templates_dir: "_plantillas", attachments_dir: "_adjuntos" },
    templates: { daily: "_plantillas/Daily Note.md" }, managed_headings: { tareas: "## Tareas", reflexion: "## Reflexión", notas: "## Notas", enlaces: "## Enlaces del día" }, budget: { context_tokens: 5000 }, conventions: { project_frontmatter_field: "resyst_project" }, project_overrides: [] };
  const journal = new JournalStore({ vaultRoot: root, identity, now: () => "2026-08-11T13:00:00.000Z" });
  return { root, stateRoot, config, identity, journal, paths: new VaultPaths(root, { identity }) };
}

const target = { path: "Notas Diarias/2026-08-11.md" as VaultPath, before_hash: "0".repeat(64), after_hash: "1".repeat(64) };
async function event(journal: JournalStore, eventId: string, key: string): Promise<void> { await journal.writeEvent({ version: 1, kind: "apply", event_id: eventId, idempotency_key: key, created_at: "2026-08-11T12:00:00.000Z", checkpoint: checkpoint(), planned_targets: [target] }); }

describe("StatusService", () => {
  it("counts each apply intent exactly once and never treats failed as pending", async () => {
    const ctx = await context();
    await event(ctx.journal, "evt-pending", "a".repeat(64));
    await event(ctx.journal, "evt-applied", "b".repeat(64));
    await event(ctx.journal, "evt-deferred", "c".repeat(64));
    await event(ctx.journal, "evt-failed", "d".repeat(64));
    await event(ctx.journal, "evt-rolled", "e".repeat(64));
    await ctx.journal.writeReceipt({ version: 1, outcome: "applied", event_id: "evt-applied", idempotency_key: "b".repeat(64), targets: [target], created_at: "2026-08-11T12:01:00.000Z" });
    await ctx.journal.writeReceipt({ version: 1, outcome: "deferred_conflict", event_id: "evt-deferred", idempotency_key: "c".repeat(64), proposal_path: "Inbox/proposal.md", conflict_paths: [target.path], targets: [target], created_at: "2026-08-11T12:02:00.000Z" });
    await ctx.journal.writeReceipt({ version: 1, outcome: "failed", event_id: "evt-failed", idempotency_key: "d".repeat(64), reason: "io_error", targets: [target], created_at: "2026-08-11T12:03:00.000Z" });
    await ctx.journal.writeReceipt({ version: 1, outcome: "applied", event_id: "evt-rolled", idempotency_key: "e".repeat(64), targets: [target], created_at: "2026-08-11T12:04:00.000Z" });
    await ctx.journal.writeEvent({ version: 1, kind: "rollback", event_id: "evt-rb", idempotency_key: "f".repeat(64), created_at: "2026-08-11T12:05:00.000Z", target_event_id: "evt-rolled", rollback_targets: [{ path: target.path, before_hash: target.after_hash, after_hash: target.before_hash }] });
    await ctx.journal.writeReceipt({ version: 1, outcome: "rolled_back", event_id: "evt-rb", idempotency_key: "f".repeat(64), target_event_id: "evt-rolled", rollback_targets: [{ path: target.path, before_hash: target.after_hash, after_hash: target.before_hash }], created_at: "2026-08-11T12:05:00.000Z" });
    const report = await new StatusService({ journal: ctx.journal, now: () => "2026-08-11T13:00:00.000Z" }).report();
    expect(report.counts).toEqual({ pending: 1, deferred: 1, applied: 1, rolled_back: 1, failed: 1, noop: 0 });
    expect(report.pending_event_ids).toEqual(["evt-pending"]);
    expect(report.recovery_required).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(ctx.root);
    expect(serialized).not.toContain("Status fixture");
  });


  it("reports a rollback intent without a receipt as recovery-required pending work", async () => {
    const ctx = await context();
    await ctx.journal.writeEvent({ version: 1, kind: "rollback", event_id: "evt-pending-rollback", idempotency_key: "9".repeat(64), created_at: "2026-08-11T12:05:00.000Z", target_event_id: "evt-original", rollback_targets: [{ path: target.path, before_hash: target.after_hash, after_hash: target.before_hash }] });
    const report = await new StatusService({ journal: ctx.journal, now: () => "2026-08-11T13:00:00.000Z" }).report();
    expect(report).toMatchObject({ recovery_required: true, pending_event_ids: ["evt-pending-rollback"], counts: { pending: 1 } });
  });
});

describe("DoctorService", () => {
  it("reports headings, pending events, conflicts and cache health without writing or leaking absolute paths", async () => {
    const ctx = await context(); await event(ctx.journal, "evt-pending", "a".repeat(64));
    await writeFile(path.join(ctx.root, "Notas Diarias", "Atlas.sync-conflict-20260811.md"), "conflict", "utf8");
    await writeFile(path.join(ctx.root, "_plantillas", "Daily Note.md"), "# day\n## Tareas\n## Reflexión\n## Notas\n", "utf8");
    const lock = new LocalLock({ stateRoot: ctx.stateRoot, pid: process.pid, processStart: "doctor-test" });
    const cache = { read: async (): Promise<unknown> => "not-json", write: async (): Promise<void> => undefined };
    const beforeState = (await readdir(ctx.stateRoot)).sort();
    const report = await new DoctorService({ config: ctx.config, journal: ctx.journal, lock, paths: ctx.paths, cache, now: () => "2026-08-11T13:00:00.000Z" }).check();
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "template_headings", status: "missing_headings", missing: ["## Enlaces del día"] }),
      expect.objectContaining({ id: "pending_events", status: "pending", event_ids: ["evt-pending"] }),
      expect.objectContaining({ id: "syncthing_conflicts", status: "conflicts", paths: ["Notas Diarias/Atlas.sync-conflict-20260811.md"] }),
      expect.objectContaining({ id: "cache", status: "corrupt" }),
      expect.objectContaining({ id: "lock", status: "free", cleanable: false }),
    ]));
    expect((await readdir(ctx.stateRoot)).sort()).toEqual(beforeState);
    expect(JSON.stringify(report)).not.toContain(ctx.root);
  });

  it("distinguishes live, abandoned and unknown locks and cleans only a re-proven abandoned owner", async () => {
    for (const liveness of [true, false, "unknown"] as const) {
      const ctx = await context();
      const owner = new LocalLock({ stateRoot: ctx.stateRoot, pid: 4242, processStart: "owner", isOwnerLive: async () => liveness });
      const held = await owner.acquire();
      const doctor = new DoctorService({ config: ctx.config, journal: ctx.journal, lock: owner, paths: ctx.paths, cache: { read: async () => null, write: async () => undefined } });
      const check = (await doctor.check()).checks.find((item) => item.id === "lock");
      expect(check).toMatchObject(liveness === true ? { status: "held_live", cleanable: false } : liveness === false ? { status: "abandoned", cleanable: true } : { status: "unknown", cleanable: false });
      const cleanup = await doctor.cleanAbandonedLock();
      expect(cleanup).toBe(liveness === false ? "removed" : liveness === true ? "not_abandoned" : "refused_unknown_liveness");
      if (liveness !== false) await held.release();
      else await expect(lstat(held.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports missing template, permissions and a healthy cache with fixed redacted diagnostics", async () => {
    const ctx = await context(); await rm(path.join(ctx.root, "_plantillas", "Daily Note.md"));
    await chmod(path.join(ctx.root, "Proyectos"), 0o000);
    try {
      const doctor = new DoctorService({ config: ctx.config, journal: ctx.journal, lock: new LocalLock({ stateRoot: ctx.stateRoot, processStart: "doctor" }), paths: ctx.paths, cache: { read: async () => JSON.stringify({ version: 1 }), write: async () => undefined } });
      const report = await doctor.check();
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "template", status: "missing" }), expect.objectContaining({ id: "vault_permissions", status: "error" }), expect.objectContaining({ id: "cache", status: "ok" })]));
      expect(JSON.stringify(report)).not.toContain(ctx.root);
    } finally { await chmod(path.join(ctx.root, "Proyectos"), 0o700); }
  });
});
