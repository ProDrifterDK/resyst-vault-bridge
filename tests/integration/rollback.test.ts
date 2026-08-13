import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalStore } from "../../src/journal.js";
import { LocalLock } from "../../src/lock.js";
import { VaultPaths, type VaultRootIdentity } from "../../src/paths.js";
import { RollbackService } from "../../src/rollback.js";
import { TransactionService, type TransactionInput } from "../../src/transaction.js";
import type { ApplyCheckpoint, EventId, EvidenceId, HashHex, HostId, IdempotencyKey, ProjectId, SessionId, VaultPath } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (value: string): HashHex => createHash("sha256").update(value, "utf8").digest("hex") as HashHex;

function checkpoint(): ApplyCheckpoint {
  return {
    version: 1, kind: "apply",
    source: { agent: "prime-agent", host_id: "casey" as HostId, session_id: "session-atlas" as SessionId, cwd: "/home/tester/synthetic/atlas" },
    project: { id: "atlas" as ProjectId },
    knowledge: { completed_tasks: [{ text: "Applied Atlas", evidence: ["test-rollback" as EvidenceId] }], decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [] },
    evidence: { commits: [], tests: [{ id: "test-rollback" as EvidenceId, value: "rollback integration" }], files: [], deployments: [], observations: [] },
    targets: { daily: true, project: true, landscape: false },
  };
}

async function setup(rollbackOptions: { afterTarget?: (target: VaultPath, index: number) => Promise<void>; beforeReceipt?: () => Promise<void> } = {}): Promise<{
  root: string; stateRoot: string; journal: JournalStore; transaction: TransactionService; rollback: RollbackService;
  daily: string; project: string; dailyBefore: string; projectBefore: string; request: TransactionInput;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-rollback-")); roots.push(root);
  await createVault({ vaultPath: root, withDailyNote: true, withProjectNote: true });
  const daily = path.join(root, "Notas Diarias", "2026-08-11.md");
  const project = path.join(root, "Proyectos", "Atlas.md");
  const dailyBefore = "# day\n## Tareas\nmanual daily\n## Reflexión\n## Notas\n## Enlaces del día\n";
  const projectBefore = "# Atlas\nmanual project\n";
  await writeFile(daily, dailyBefore, "utf8"); await writeFile(project, projectBefore, "utf8");
  const dailyAfter = dailyBefore.replace("manual daily", "manual daily\n- [x] bridge");
  const projectAfter = `${projectBefore}<!-- resyst:session:start -->\nDone\n<!-- resyst:session:end -->\n`;
  const rootStat = await stat(root, { bigint: true });
  const identity: VaultRootIdentity = { real_path: await realpath(root), dev: rootStat.dev, ino: rootStat.ino };
  const stateRoot = `${root}-state`; roots.push(stateRoot);
  const journal = new JournalStore({ vaultRoot: root, identity, now: () => "2026-08-11T12:00:00.000Z" });
  const lock = new LocalLock({ stateRoot, pid: process.pid, processStart: "rollback-test" });
  const paths = new VaultPaths(root, { identity });
  const transaction = new TransactionService({ vaultRoot: root, stateRoot, identity, paths, inboxDir: "Inbox", journal, lock, now: () => "2026-08-11T12:00:00.000Z" });
  const rollbackOptions_: Record<string, unknown> = {};
  if (rollbackOptions.afterTarget !== undefined) rollbackOptions_.afterTarget = rollbackOptions.afterTarget;
  if (rollbackOptions.beforeReceipt !== undefined) rollbackOptions_.beforeReceipt = rollbackOptions.beforeReceipt;
  const rollback = new RollbackService({ vaultRoot: root, stateRoot, identity, paths, journal, lock, now: () => "2026-08-11T12:05:00.000Z", ...rollbackOptions_ });
  const request: TransactionInput = { checkpoint: checkpoint(), idempotency_key: "b".repeat(64) as IdempotencyKey, event_id: "evt-applied-atlas" as EventId, plans: [
    { path: "Proyectos/Atlas.md" as VaultPath, before_hash: hash(projectBefore), after_content: projectAfter, after_hash: hash(projectAfter), reason: "project_update" },
    { path: "Notas Diarias/2026-08-11.md" as VaultPath, before_hash: hash(dailyBefore), after_content: dailyAfter, after_hash: hash(dailyAfter), reason: "daily_update" },
  ] };
  return { root, stateRoot, journal, transaction, rollback, daily, project, dailyBefore, projectBefore, request };
}

const rollbackRequest = { target_event_id: "evt-applied-atlas", event_id: "evt-rollback-atlas", idempotency_key: "c".repeat(64) };

describe("RollbackService", () => {
  it("restores every exact after-hash, writes linked audit records, and is idempotent", async () => {
    const ctx = await setup();
    expect((await ctx.transaction.apply(ctx.request)).kind).toBe("applied");
    const result = await ctx.rollback.rollback(rollbackRequest);
    expect(result.kind).toBe("rolled_back");
    expect(await readFile(ctx.daily, "utf8")).toBe(ctx.dailyBefore);
    expect(await readFile(ctx.project, "utf8")).toBe(ctx.projectBefore);
    if (result.kind === "rolled_back") {
      expect(result.receipt.target_event_id).toBe("evt-applied-atlas");
      expect(result.receipt.rollback_targets.map((target) => target.path)).toEqual(["Notas Diarias/2026-08-11.md", "Proyectos/Atlas.md"]);
    }
    expect(await ctx.journal.readEvent("evt-rollback-atlas")).toMatchObject({ kind: "rollback", target_event_id: "evt-applied-atlas" });
    const repeated = await ctx.rollback.rollback(rollbackRequest);
    expect(repeated.kind).toBe("already_rolled_back");
  });

  it("rejects a later user edit without partially restoring any target", async () => {
    const ctx = await setup(); await ctx.transaction.apply(ctx.request);
    const dailyAfter = ctx.request.plans.find((plan) => plan.path.startsWith("Notas Diarias"))!.after_content;
    await writeFile(ctx.project, "later user edit\n", "utf8");
    const result = await ctx.rollback.rollback(rollbackRequest);
    expect(result).toMatchObject({ kind: "rejected", reason: "precondition_mismatch", mismatch_paths: ["Proyectos/Atlas.md"] });
    expect(await readFile(ctx.daily, "utf8")).toBe(dailyAfter);
    expect(await readFile(ctx.project, "utf8")).toBe("later user edit\n");
  });

  it("rejects a partial event and a missing backup fail closed", async () => {
    const partial = await setup();
    await partial.journal.writeEvent({ version: 1, kind: "apply", event_id: "evt-applied-atlas", idempotency_key: "b".repeat(64), created_at: "2026-08-11T12:00:00.000Z", checkpoint: checkpoint(), planned_targets: partial.request.plans.map((plan) => ({ path: plan.path, before_hash: plan.before_hash, after_hash: plan.after_hash })) });
    expect(await partial.rollback.rollback(rollbackRequest)).toMatchObject({ kind: "rejected", reason: "not_applied" });

    const missing = await setup(); await missing.transaction.apply(missing.request);
    const backupDir = path.join(missing.stateRoot, "resyst-vault", "backups", "evt-applied-atlas");
    const backupName = (await readdir(backupDir)).find((name) => name.endsWith(".before"));
    expect(backupName).toBeDefined(); await rm(path.join(backupDir, backupName!));
    expect(await missing.rollback.rollback(rollbackRequest)).toMatchObject({ kind: "rejected", reason: "missing_backup" });
    expect(await readFile(missing.daily, "utf8")).toBe(missing.request.plans[1]!.after_content);
    expect(await readFile(missing.project, "utf8")).toBe(missing.request.plans[0]!.after_content);
  });

  it("deletes a file created by the applied event", async () => {
    const ctx = await setup();
    const created = "Inbox/generated.md" as VaultPath;
    const content = "generated\n";
    const request: TransactionInput = { ...ctx.request, event_id: "evt-created" as EventId, idempotency_key: "d".repeat(64) as IdempotencyKey, plans: [{ path: created, before_hash: null, after_content: content, after_hash: hash(content), reason: "daily_create" }] };
    await ctx.transaction.apply(request);
    const result = await ctx.rollback.rollback({ target_event_id: "evt-created", event_id: "evt-rollback-created", idempotency_key: "e".repeat(64) });
    expect(result.kind).toBe("rolled_back");
    await expect(readFile(path.join(ctx.root, created), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes the remaining targets when the previous attempt crashed after target 1", async () => {
    let crashOnce = true;
    const crashed = await setup({ afterTarget: async (_target: VaultPath, index: number) => {
      if (index === 0 && crashOnce) {
        crashOnce = false;
        throw new Error("crash after first target");
      }
    } });
    await crashed.transaction.apply(crashed.request);
    await expect(crashed.rollback.rollback(rollbackRequest)).rejects.toThrow("crash after first target");
    // After the crash: target 0 (Notas Diarias) is restored, target 1 (Proyectos) is still in the after state.
    expect(await readFile(crashed.daily, "utf8")).toBe(crashed.dailyBefore);
    expect(await readFile(crashed.project, "utf8")).toBe(crashed.request.plans[0]!.after_content);
    // Retry completes the remaining target, writes a single durable receipt, and is idempotent on further retries.
    const completed = await crashed.rollback.rollback(rollbackRequest);
    expect(completed.kind).toBe("rolled_back");
    expect(await readFile(crashed.daily, "utf8")).toBe(crashed.dailyBefore);
    expect(await readFile(crashed.project, "utf8")).toBe(crashed.projectBefore);
    const repeated = await crashed.rollback.rollback(rollbackRequest);
    expect(repeated.kind).toBe("already_rolled_back");
  });

  it("writes the receipt idempotently when the previous attempt crashed after all operations but before receipt", async () => {
    let crashOnce = true;
    const crashed = await setup({ beforeReceipt: async () => {
      if (crashOnce) {
        crashOnce = false;
        throw new Error("crash before receipt");
      }
    } });
    await crashed.transaction.apply(crashed.request);
    await expect(crashed.rollback.rollback(rollbackRequest)).rejects.toThrow("crash before receipt");
    // After the crash: every target is restored, the rollback event is durable, the receipt is missing.
    expect(await readFile(crashed.daily, "utf8")).toBe(crashed.dailyBefore);
    expect(await readFile(crashed.project, "utf8")).toBe(crashed.projectBefore);
    const completed = await crashed.rollback.rollback(rollbackRequest);
    expect(completed.kind).toBe("rolled_back");
    if (completed.kind === "rolled_back") {
      expect(completed.receipt.target_event_id).toBe("evt-applied-atlas");
      expect(completed.receipt.rollback_targets.map((t) => t.path)).toEqual(["Notas Diarias/2026-08-11.md", "Proyectos/Atlas.md"]);
    }
    const repeated = await crashed.rollback.rollback(rollbackRequest);
    expect(repeated.kind).toBe("already_rolled_back");
  });

  it("rechecks idempotency under the lock so a concurrent loser is already rolled back", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const ctx = await setup({ afterTarget: async (_target, index) => { if (index === 0) { enteredResolve?.(); await release; } } });
    await ctx.transaction.apply(ctx.request);
    const rootState = await stat(ctx.root, { bigint: true });
    const identity: VaultRootIdentity = { real_path: await realpath(ctx.root), dev: rootState.dev, ino: rootState.ino };
    const second = new RollbackService({ vaultRoot: ctx.root, stateRoot: ctx.stateRoot, identity, paths: new VaultPaths(ctx.root, { identity }), journal: ctx.journal, lock: new LocalLock({ stateRoot: ctx.stateRoot, pid: process.pid, processStart: "rollback-test" }), now: () => "2026-08-11T12:05:00.000Z" });
    const firstPromise = ctx.rollback.rollback(rollbackRequest);
    await entered;
    const secondPromise = second.rollback(rollbackRequest);
    releaseResolve?.();
    const [first, loser] = await Promise.all([firstPromise, secondPromise]);
    expect(first.kind).toBe("rolled_back");
    expect(loser.kind).toBe("already_rolled_back");
  });

  it("rejects a symlinked backup state chain without reading outside bytes", async () => {
    const ctx = await setup();
    await ctx.transaction.apply(ctx.request);
    const backups = path.join(ctx.stateRoot, "resyst-vault", "backups");
    const moved = `${backups}-real`;
    const outside = await mkdtemp(path.join(os.tmpdir(), "resyst-rollback-outside-")); roots.push(outside);
    await rename(backups, moved);
    await mkdir(backups, { recursive: true });
    await rm(backups, { recursive: true });
    await symlink(outside, backups);
    const result = await ctx.rollback.rollback(rollbackRequest);
    expect(result).toMatchObject({ kind: "rejected", reason: "invalid_state" });
    expect(await readdir(outside)).toEqual([]);
  });

});
