import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalStore } from "../../src/journal.js";
import { LocalLock } from "../../src/lock.js";
import { VaultPaths, type VaultRootIdentity } from "../../src/paths.js";
import { RecoveryService } from "../../src/recovery.js";
import { TransactionCrashError, TransactionIntegrityError, TransactionService, type TransactionInput } from "../../src/transaction.js";
import type { WritePlan } from "../../src/render.js";
import type { ApplyCheckpoint, EvidenceId, HashHex, HostId, IdempotencyKey, ProjectId, SessionId, VaultPath } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (value: string): HashHex => createHash("sha256").update(value, "utf8").digest("hex") as HashHex;

function checkpoint(): ApplyCheckpoint {
  return {
    version: 1,
    kind: "apply",
    source: { agent: "prime-agent", host_id: "casey" as HostId, session_id: "session-atlas" as SessionId, cwd: "/synthetic/atlas" },
    project: { id: "atlas" as ProjectId },
    knowledge: { completed_tasks: [{ text: "Finished Atlas recovery", evidence: ["test-1" as EvidenceId] }], decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [] },
    evidence: { commits: [], tests: [{ id: "test-1" as EvidenceId, value: "recovery integration" }], files: [], deployments: [], observations: [] },
    targets: { daily: true, project: true, landscape: false },
  };
}

async function fixture(): Promise<{
  root: string;
  stateRoot: string;
  dailyPath: string;
  projectPath: string;
  dailyBefore: string;
  projectBefore: string;
  request: TransactionInput;
  journal: JournalStore;
  transaction: TransactionService;
  recovery: RecoveryService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-recovery-")); roots.push(root);
  await createVault({ vaultPath: root, withDailyNote: true, withProjectNote: true });
  const dailyPath = path.join(root, "Notas Diarias", "2026-08-11.md");
  const projectPath = path.join(root, "Proyectos", "Atlas.md");
  const dailyBefore = "# 2026-08-11\n\n## Tareas\n\n## Reflexión\n\n## Notas\n\n## Enlaces del día\n";
  const projectBefore = "---\nresyst_project:\n  id: atlas\n  repos: []\n  aliases: []\n---\n# Atlas\n\n## Status\nmanual\n";
  await writeFile(dailyPath, dailyBefore, "utf8");
  await writeFile(projectPath, projectBefore, "utf8");
  const dailyAfter = dailyBefore.replace("## Tareas\n", "## Tareas\n- [x] recovered daily\n");
  const projectAfter = `${projectBefore}\n<!-- resyst:session:start -->\nRecovered Atlas\n<!-- resyst:session:end -->\n`;
  const rootStat = await stat(root, { bigint: true });
  const identity: VaultRootIdentity = { real_path: await realpath(root), dev: rootStat.dev, ino: rootStat.ino };
  const stateRoot = `${root}-state`; roots.push(stateRoot);
  const journal = new JournalStore({ vaultRoot: root, identity, now: () => "2026-08-11T12:00:00.000Z" });
  const lock = new LocalLock({ stateRoot, pid: process.pid, processStart: "recovery-test" });
  const transaction = new TransactionService({ vaultRoot: root, stateRoot, identity, paths: new VaultPaths(root, { identity }), inboxDir: "Inbox", journal, lock, now: () => "2026-08-11T12:00:00.000Z" });
  const request: TransactionInput = {
    checkpoint: checkpoint(),
    idempotency_key: "a".repeat(64) as IdempotencyKey,
    event_id: "evt-recovery-atlas" as TransactionInput["event_id"],
    plans: [
      { path: "Proyectos/Atlas.md" as VaultPath, before_hash: hash(projectBefore), after_content: projectAfter, after_hash: hash(projectAfter), reason: "project_update" },
      { path: "Notas Diarias/2026-08-11.md" as VaultPath, before_hash: hash(dailyBefore), after_content: dailyAfter, after_hash: hash(dailyAfter), reason: "daily_update" },
    ],
  };
  return { root, stateRoot, dailyPath, projectPath, dailyBefore, projectBefore, request, journal, transaction, recovery: new RecoveryService({ journal, transaction, now: () => "2026-08-11T12:01:00.000Z" }) };
}

async function progressFiles(stateRoot: string, eventId: string): Promise<string[]> {
  return (await readdir(path.join(stateRoot, "resyst-vault", "backups", eventId))).filter((name) => name.startsWith("progress-")).sort();
}

describe("multi-target apply and recovery", () => {
  it("prepares every target, renames in deterministic path order, and documents temporary cross-file visibility", async () => {
    const ctx = await fixture();
    const order: string[] = [];
    const result = await ctx.transaction.apply({ ...ctx.request, hooks: { afterRename: async (plan: WritePlan) => { order.push(plan.path); if (order.length === 1) expect(await readFile(ctx.projectPath, "utf8")).toBe(ctx.projectBefore); } } });
    expect(result.kind).toBe("applied");
    expect(order).toEqual(["Notas Diarias/2026-08-11.md", "Proyectos/Atlas.md"]);
    expect(await progressFiles(ctx.stateRoot, "evt-recovery-atlas")).toHaveLength(2);
    if (result.kind === "applied") expect(result.receipt.targets.map((target) => target.path)).toEqual(order);
    expect((await ctx.transaction.apply(ctx.request)).kind).toBe("already_applied");
  });


  it("continues the recovery batch when one event has no prepared frontier", async () => {
    const ctx = await fixture();
    await ctx.journal.writeEvent({
      version: 1, kind: "apply", event_id: "evt-unprepared", idempotency_key: "f".repeat(64), created_at: "2026-08-11T11:59:00.000Z",
      checkpoint: checkpoint(), planned_targets: ctx.request.plans.map((plan) => ({ path: plan.path, before_hash: plan.before_hash, after_hash: plan.after_hash })),
    });
    await expect(ctx.transaction.apply({ ...ctx.request, hooks: { afterRename: async (_plan: WritePlan, index: number) => { if (index === 1) throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
    const result = await ctx.recovery.recover();
    expect(result).toMatchObject({ kind: "recovered", completed_event_ids: ["evt-recovery-atlas"], failed_event_ids: ["evt-unprepared"] });
    await expect(ctx.journal.readReceipt("evt-unprepared")).rejects.toBeDefined();
    const repeated = await ctx.recovery.recover();
    expect(repeated).toMatchObject({ kind: "recovered", failed_event_ids: ["evt-unprepared"] });
    const third = await ctx.recovery.recover();
    expect(third).toMatchObject({ kind: "recovered", event_id: repeated.kind === "recovered" ? repeated.event_id : undefined, failed_event_ids: ["evt-unprepared"] });
  });

  it("recovers a crash before the first rename from durable prepared files", async () => {
    const ctx = await fixture();
    await expect(ctx.transaction.apply({ ...ctx.request, hooks: { beforeRename: async (_plan: WritePlan, index: number) => { if (index === 0) throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
    expect(await readFile(ctx.dailyPath, "utf8")).toBe(ctx.dailyBefore);
    expect(await readFile(ctx.projectPath, "utf8")).toBe(ctx.projectBefore);
    expect(await progressFiles(ctx.stateRoot, "evt-recovery-atlas")).toHaveLength(2);
    const outcome = await ctx.recovery.recover();
    expect(outcome).toMatchObject({ kind: "recovered", completed_event_ids: ["evt-recovery-atlas"], deferred_event_ids: [] });
    expect(await readFile(ctx.dailyPath, "utf8")).toBe(ctx.request.plans[1]!.after_content);
    expect(await readFile(ctx.projectPath, "utf8")).toBe(ctx.request.plans[0]!.after_content);
  });

  it("recovers between renames and after all renames without duplicate fragments", async () => {
    for (const crashIndex of [0, 1]) {
      const ctx = await fixture();
      await expect(ctx.transaction.apply({ ...ctx.request, hooks: { afterRename: async (_plan: WritePlan, index: number) => { if (index === crashIndex) throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
      const result = await ctx.recovery.recover();
      expect(result.kind).toBe("recovered");
      expect(await readFile(ctx.dailyPath, "utf8")).toBe(ctx.request.plans[1]!.after_content);
      expect(await readFile(ctx.projectPath, "utf8")).toBe(ctx.request.plans[0]!.after_content);
      expect((await ctx.recovery.recover()).kind).toBe("nothing_pending");
    }
  });

  it("defers rather than overwriting when a target leaves the recorded frontier", async () => {
    const ctx = await fixture();
    await expect(ctx.transaction.apply({ ...ctx.request, hooks: { afterRename: async (_plan: WritePlan, index: number) => { if (index === 0) throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
    await writeFile(ctx.projectPath, `${ctx.projectBefore}later user edit\n`, "utf8");
    const result = await ctx.recovery.recover();
    expect(result).toMatchObject({ kind: "recovered", completed_event_ids: [], deferred_event_ids: ["evt-recovery-atlas"] });
    expect(await readFile(ctx.projectPath, "utf8")).toContain("later user edit");
    expect((await readdir(path.dirname(ctx.projectPath))).some((name) => name.includes(".resyst-"))).toBe(false);
  });

  it("derives a unique content-bound recovery marker from the recovered batch only", async () => {
    const ctx = await fixture();
    await expect(ctx.transaction.apply({ ...ctx.request, hooks: { beforeRename: async () => { throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
    const recovered = await ctx.recovery.recover();
    expect(recovered.kind).toBe("recovered");
    if (recovered.kind !== "recovered") return;
    // Content-bound: the marker must NOT change with the wall clock, and two
    // independent recoveries over the same recovered batch must agree.
    const persisted = await ctx.journal.readEvent(recovered.event_id);
    expect(persisted).toMatchObject({ kind: "recover" });
    if (persisted.kind !== "recover") return;
    const idempotencyKey = String(persisted.idempotency_key);
    expect(idempotencyKey).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/u.test(idempotencyKey)).toBe(true);
    // Re-derive the digest from the recovered batch alone and confirm it
    // matches the persisted marker; the audit event_id is `recover-<digest32>`.
    const { createHash } = await import("node:crypto");
    const sortedCompleted = [...recovered.completed_event_ids].sort((left, right) => String(left).localeCompare(String(right)));
    const expectedDigest = createHash("sha256").update(JSON.stringify({ completed: sortedCompleted, deferred: [], failed: [] }), "utf8").digest("hex");
    expect(expectedDigest).toBe(idempotencyKey);
    expect(recovered.event_id).toBe(`recover-${expectedDigest.slice(0, 32)}`);
    // After settling, nothing else is pending: a follow-up recovery is a
    // no-op, demonstrating that the marker is a one-shot content seal.
    expect((await ctx.recovery.recover()).kind).toBe("nothing_pending");
  });

  it("fails closed on corrupt progress and does not guess", async () => {
    const ctx = await fixture();
    await expect(ctx.transaction.apply({ ...ctx.request, hooks: { beforeRename: async () => { throw new TransactionCrashError(); } } })).rejects.toBeInstanceOf(TransactionCrashError);
    const [first] = await progressFiles(ctx.stateRoot, "evt-recovery-atlas");
    expect(first).toBeDefined();
    await writeFile(path.join(ctx.stateRoot, "resyst-vault", "backups", "evt-recovery-atlas", first!), "{}", "utf8");
    await expect(ctx.recovery.recover()).rejects.toBeInstanceOf(TransactionIntegrityError);
    expect(await readFile(ctx.dailyPath, "utf8")).toBe(ctx.dailyBefore);
    expect(await readFile(ctx.projectPath, "utf8")).toBe(ctx.projectBefore);
  });
});
