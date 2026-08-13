import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalIntegrityError, JournalStore } from "../../src/journal.js";
import { LocalLock, LockIntegrityError } from "../../src/lock.js";
import { VaultPaths, type VaultRootIdentity } from "../../src/paths.js";
import { TransactionCrashError, TransactionIntegrityError, TransactionService, type TransactionInput } from "../../src/transaction.js";
import type { ApplyCheckpoint, EvidenceId, HashHex, HostId, IdempotencyKey, ProjectId, SessionId, VaultPath } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hash = (value: string): HashHex => createHash("sha256").update(value, "utf8").digest("hex") as HashHex;

function checkpoint(knowledgeText = "Applied the daily update"): ApplyCheckpoint {
  return {
    version: 1,
    kind: "apply",
    source: {
      agent: "prime-agent",
      host_id: "casey" as HostId,
      session_id: "sess-01" as SessionId,
      cwd: "/home/tester/atlas",
    },
    project: { id: "atlas" as ProjectId },
    knowledge: {
      completed_tasks: [{ text: knowledgeText, evidence: ["t1" as EvidenceId] }],
      decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [],
    },
    evidence: {
      commits: [], tests: [{ id: "t1" as EvidenceId, value: "transaction test" }],
      files: [], deployments: [], observations: [],
    },
    targets: { daily: true, project: false, landscape: false },
  };
}

function input(
  content: string,
  before: HashHex | null,
  key = "b".repeat(64),
  eventId = "evt-task8",
  knowledgeText = "Applied the daily update",
): TransactionInput {
  return {
    checkpoint: checkpoint(knowledgeText),
    idempotency_key: key as IdempotencyKey,
    event_id: eventId as TransactionInput["event_id"],
    plans: [{
      path: "Notas Diarias/2026-08-11.md" as VaultPath,
      before_hash: before,
      after_content: content,
      after_hash: hash(content),
      reason: "daily_update",
    }],
  };
}

async function service(root: string, inboxDir = "Inbox", suppliedLock?: LocalLock): Promise<TransactionService> {
  const stateRoot = path.join(path.dirname(root), `${path.basename(root)}-state`);
  roots.push(stateRoot);
  const rootStat = await stat(root, { bigint: true });
  const identity: VaultRootIdentity = { real_path: await realpath(root), dev: rootStat.dev, ino: rootStat.ino };
  const paths = new VaultPaths(root, { identity });
  return new TransactionService({
    vaultRoot: root,
    stateRoot,
    identity,
    paths,
    inboxDir,
    journal: new JournalStore({ vaultRoot: root, identity }),
    lock: suppliedLock ?? new LocalLock({ stateRoot, pid: process.pid, processStart: "test-start" }),
  });
}

async function targetSource(root: string): Promise<{ absolute: string; before: string }> {
  const absolute = path.join(root, "Notas Diarias", "2026-08-11.md");
  const before = [
    "manual prefix — Casey",
    "# 2026-08-11",
    "",
    "## Tareas",
    "manual task context",
    "",
    "## Reflexión",
    "manual reflection",
    "",
    "## Notas",
    "manual note context",
    "",
    "## Enlaces del día",
    "manual links",
    "",
    "manual suffix — Atlas",
    "",
  ].join("\n");
  await writeFile(absolute, before, "utf8");
  return { absolute, before };
}

describe("TransactionService single-target apply", () => {
  it("journals first, atomically applies one target, creates backup/progress/receipt, preserves mode and manual bytes, and retries idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-")); roots.push(root);
    const vault = await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    await chmod(target, 0o640);
    const beforeMode = (await stat(target)).mode & 0o7777;
    const replacement = before.replace("## Tareas\n", "## Tareas\n\n<!-- managed -->\n");
    const tx = await service(root);
    const request = input(replacement, hash(before));
    const result = await tx.apply(request);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;

    expect(await readFile(target, "utf8")).toBe(replacement);
    expect((await stat(target)).mode & 0o7777).toBe(beforeMode);
    const changedStart = before.indexOf("## Tareas\n") + "## Tareas\n".length;
    expect(replacement.slice(0, changedStart)).toBe(before.slice(0, changedStart));
    expect(replacement.slice(changedStart + "\n<!-- managed -->\n".length)).toBe(before.slice(changedStart));
    expect(result.receipt).toEqual({
      version: 1,
      outcome: "applied",
      event_id: "evt-task8",
      idempotency_key: "b".repeat(64),
      targets: [{ path: "Notas Diarias/2026-08-11.md", before_hash: hash(before), after_hash: hash(replacement) }],
      created_at: result.receipt.created_at,
    });
    const receiptLookup = await new JournalStore({ vaultRoot: root, identity: {
      real_path: await realpath(root), dev: (await stat(root, { bigint: true })).dev, ino: (await stat(root, { bigint: true })).ino,
    } }).findReceiptByIdempotency("b".repeat(64));
    expect(receiptLookup?.receipt).toEqual(result.receipt);
    const journal = new JournalStore({ vaultRoot: root, identity: {
      real_path: await realpath(root), dev: (await stat(root, { bigint: true })).dev, ino: (await stat(root, { bigint: true })).ino,
    } });
    expect(await journal.findEventByIdempotency("b".repeat(64))).not.toBeNull();
    const backupDir = path.join(tx.backupRoot, "evt-task8");
    const backupNames = await readdir(backupDir);
    const backupFile = backupNames.find((name) => name.endsWith(".before"));
    expect(backupFile).toBeDefined();
    expect(await readFile(path.join(backupDir, backupFile!), "utf8")).toBe(before);
    const progressName = backupNames.find((name) => name.startsWith("progress-"));
    expect(progressName).toBeDefined();
    const progress = JSON.parse(await readFile(path.join(backupDir, progressName!), "utf8")) as Record<string, unknown>;
    expect(progress).toMatchObject({ event_id: "evt-task8", state: "renamed", path: "Notas Diarias/2026-08-11.md" });
    expect(backupNames.some((name) => name.includes(".tmp") || name.includes(".resyst-"))).toBe(false);
    const retried = await tx.apply(request);
    expect(retried.kind).toBe("already_applied");
    if (retried.kind === "already_applied") expect(retried.original_receipt).toEqual(result.receipt);
    expect((await readdir(backupDir)).filter((name) => name.endsWith(".before"))).toHaveLength(1);
    void vault;
  });

  it("defers stale hash, targets a configured Inbox, and escapes proposal data through the same primitive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-conflict-")); roots.push(root);
    const vault = await createVault({ vaultPath: root, withDailyNote: true, layout: { inboxDir: "Propuestas" } });
    const { absolute: target, before } = await targetSource(root);
    const tx = await service(root, "Propuestas");
    const malicious = "<img src=x> [unsafe](javascript:alert(1)) | `code`";
    const result = await tx.apply(input(before + "\nproposed\n", "0".repeat(64) as HashHex, "d".repeat(64), "evt-conflict", malicious));
    expect(result.kind).toBe("deferred_conflict");
    if (result.kind !== "deferred_conflict") return;
    expect(await readFile(target, "utf8")).toBe(before);
    expect(result.receipt.proposal_path).toBe("Propuestas/resyst-proposal-evt-conflict.md");
    const proposal = await readFile(path.join(root, result.receipt.proposal_path), "utf8");
    expect(proposal).toContain("&lt;img src=x>");
    expect(proposal).toContain("\\[unsafe\\]");
    expect(proposal).not.toContain("<img src=x>");
    const names = await readdir(vault.paths.inboxDir);
    expect(names.filter((name) => name === "resyst-proposal-evt-conflict.md")).toHaveLength(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await tx.apply(input(before + "\nproposed\n", "0".repeat(64) as HashHex, "d".repeat(64), "evt-conflict", malicious))).toEqual(result);
  });

  it("persists the event and backup but fails safely before rename, cleans temps, and leaves bytes unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-failure-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const tx = await service(root);
    const request = input(before + "changed", hash(before), "e".repeat(64), "evt-failure");
    const failed = await tx.apply({ ...request, hooks: { beforeRename: async () => { throw new Error("injected"); } } });
    expect(failed.kind).toBe("failed");
    expect(await readFile(target, "utf8")).toBe(before);
    const journal = new JournalStore({ vaultRoot: root, identity: {
      real_path: await realpath(root), dev: (await stat(root, { bigint: true })).dev, ino: (await stat(root, { bigint: true })).ino,
    } });
    expect(await journal.findEventByIdempotency("e".repeat(64))).not.toBeNull();
    if (failed.kind === "failed") expect(failed.receipt.reason).toBe("io_error");
    const backupDir = path.join(tx.backupRoot, "evt-failure");
    const [progressName] = (await readdir(backupDir)).filter((name) => name.startsWith("progress-"));
    expect(progressName).toBeDefined();
    expect(JSON.parse(await readFile(path.join(backupDir, progressName!), "utf8"))).toMatchObject({ state: "prepared" });
    expect((await readdir(path.dirname(target))).some((name) => name.includes(".resyst-"))).toBe(false);
  });

  it("rechecks the receipt after lock wait so a concurrent same-key loser is already applied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-concurrent-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const firstTx = await service(root);
    const secondTx = await service(root);
    const request = input(before + "concurrent", hash(before), "5".repeat(64), "evt-concurrent");
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const firstPromise = firstTx.apply({
      ...request,
      hooks: {
        beforeRename: async () => {
          enteredResolve?.();
          await release;
        },
      },
    });
    await entered;
    const secondPromise = secondTx.apply(request);
    releaseResolve?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.kind).toBe("applied");
    expect(second.kind).toBe("already_applied");
    expect(await readFile(target, "utf8")).toBe(before + "concurrent");
  });

  it("converges concurrent same-intent event publication with different timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-event-race-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const firstTx = await service(root);
    const secondTx = await service(root);
    const request = input(before + "event race", hash(before), "9".repeat(64), "evt-event-race");
    const outcomes = await Promise.all([firstTx.apply(request), secondTx.apply(request)]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["already_applied", "applied"]);
    expect(await readFile(target, "utf8")).toBe(before + "event race");
  });

  it("recovers a crash after durable rename/progress without creating a failed receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-crash-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const tx = await service(root);
    const request = input(before + "after crash", hash(before), "c".repeat(64), "evt-crash");
    await expect(tx.apply({
      ...request,
      hooks: { afterRename: async () => { throw new TransactionCrashError(); } },
    })).rejects.toBeInstanceOf(TransactionCrashError);
    expect(await readFile(target, "utf8")).toBe(before + "after crash");
    const backupDir = path.join(tx.backupRoot, "evt-crash");
    const [progressName] = (await readdir(backupDir)).filter((name) => name.startsWith("progress-"));
    expect(progressName).toBeDefined();
    expect(JSON.parse(await readFile(path.join(backupDir, progressName!), "utf8"))).toMatchObject({ state: "renamed" });
    const recovered = await tx.apply(request);
    expect(recovered.kind).toBe("applied");
    const retried = await tx.apply(request);
    expect(retried.kind).toBe("already_applied");
  });

  it("fails closed on corrupt durable progress instead of treating it as a conflict", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-corrupt-progress-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const tx = await service(root);
    const request = input(before + "corrupt", hash(before), "4".repeat(64), "evt-corrupt-progress");
    await expect(tx.apply({
      ...request,
      hooks: { afterRename: async () => { throw new TransactionCrashError(); } },
    })).rejects.toBeInstanceOf(TransactionCrashError);
    const progressDirectory = path.join(tx.backupRoot, "evt-corrupt-progress");
    const [progressName] = (await readdir(progressDirectory)).filter((name) => name.startsWith("progress-"));
    expect(progressName).toBeDefined();
    await writeFile(path.join(progressDirectory, progressName!), "{}", "utf8");
    await expect(tx.apply(request)).rejects.toBeInstanceOf(TransactionIntegrityError);
    expect(await readFile(target, "utf8")).toBe(before + "corrupt");
  });

  it("rejects malformed process state through the lock owner boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-process-start-")); roots.push(root);
    const lock = new LocalLock({ stateRoot: root, pid: process.pid, processStart: "x".repeat(257) });
    await expect(lock.acquire()).rejects.toBeInstanceOf(LockIntegrityError);
  });

  it("surfaces lock release corruption after an applied receipt instead of writing a contradictory failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-release-corruption-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const stateRoot = path.join(path.dirname(root), `${path.basename(root)}-state`); roots.push(stateRoot);
    const realLock = new LocalLock({ stateRoot, pid: process.pid, processStart: "test-start" });
    const corruptLock = {
      acquire: async () => {
        const held = await realLock.acquire();
        return {
          owner: held.owner,
          path: held.path,
          release: async () => {
            await held.release();
            throw new Error("simulated release corruption");
          },
        };
      },
    } as unknown as LocalLock;
    const tx = await service(root, "Inbox", corruptLock);
    const request = input(before + "release", hash(before), "6".repeat(64), "evt-release-corruption");
    await expect(tx.apply(request)).rejects.toBeInstanceOf(TransactionIntegrityError);
    const retried = await tx.apply(request);
    expect(retried.kind).toBe("already_applied");
    expect(await readFile(target, "utf8")).toBe(before + "release");
  });

  it("rejects a target symlink swap without touching the outside file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-symlink-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside bytes", "utf8");
    await rm(target);
    await symlink(outside, target);
    const tx = await service(root);
    const result = await tx.apply(input("overwrite", hash(before), "f".repeat(64), "evt-symlink"));
    expect(result.kind).toBe("deferred_conflict");
    expect(await readlink(target)).toBe(outside);
    expect(await readFile(outside, "utf8")).toBe("outside bytes");
  });

  it("fails closed when the configured vault root is replaced after service construction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-root-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { before } = await targetSource(root);
    const tx = await service(root);
    const moved = `${root}-moved`;
    const replacement = `${root}-replacement`;
    roots.push(moved, replacement);
    await rename(root, moved);
    await createVault({ vaultPath: replacement, withDailyNote: true });
    await rename(replacement, root);
    await expect(tx.apply(input(before + "new", hash(before), "1".repeat(64), "evt-root"))).rejects.toBeInstanceOf(JournalIntegrityError);
  });
  it("recovers from a crash between durable rename and progress update by repairing the frontier and finishing idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-preprogress-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { absolute: target, before } = await targetSource(root);
    const tx = await service(root);
    const request = input(before + "after pre-progress crash", hash(before), "9".repeat(64), "evt-preprogress");
    await expect(tx.apply({
      ...request,
      hooks: { afterRenamePreProgress: async () => { throw new TransactionCrashError(); } },
    })).rejects.toBeInstanceOf(TransactionCrashError);
    // After the seam, the file is in the after state but progress is still
    // "prepared". Re-applying must observe the after hash, repair the
    // frontier to "renamed", and complete the apply with one durable receipt.
    expect(await readFile(target, "utf8")).toBe(before + "after pre-progress crash");
    const recovered = await tx.apply(request);
    expect(recovered.kind).toBe("applied");
    const retried = await tx.apply(request);
    expect(retried.kind).toBe("already_applied");
  });

  it("fails closed when the machine-local backups parent is symlinked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-state-link-")); roots.push(root);
    await createVault({ vaultPath: root, withDailyNote: true });
    const { before } = await targetSource(root);
    const stateRoot = path.join(path.dirname(root), `${path.basename(root)}-state-link`);
    roots.push(stateRoot);
    const outside = await mkdtemp(path.join(os.tmpdir(), "resyst-tx-state-outside-")); roots.push(outside);
    await mkdir(path.join(stateRoot, "resyst-vault"), { recursive: true });
    await symlink(outside, path.join(stateRoot, "resyst-vault", "backups"));
    const rootStat = await stat(root, { bigint: true });
    const identity: VaultRootIdentity = { real_path: await realpath(root), dev: rootStat.dev, ino: rootStat.ino };
    const paths = new VaultPaths(root, { identity });
    const tx = new TransactionService({
      vaultRoot: root,
      stateRoot,
      identity,
      paths,
      inboxDir: "Inbox",
      journal: new JournalStore({ vaultRoot: root, identity }),
      lock: new LocalLock({ stateRoot, pid: process.pid, processStart: "test-start" }),
    });
    await expect(tx.apply(input(before + "changed", hash(before), "2".repeat(64), "evt-state-link"))).rejects.toBeInstanceOf(TransactionIntegrityError);
    expect(await readdir(outside)).toEqual([]);
  });

});
