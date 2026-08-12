import { chmod, mkdir, mkdtemp, rename, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalStore, JournalIntegrityError } from "../../src/journal.js";
import { parseJournalEvent } from "../../src/schemas.js";
import type { JournalEvent } from "../../src/types.js";
import type { VaultRootIdentity } from "../../src/paths.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = "a".repeat(64);
const hashB = "b".repeat(64);
async function identity(root: string): Promise<VaultRootIdentity> {
  const rootStat = await stat(root, { bigint: true });
  return { real_path: await realpath(root), dev: rootStat.dev, ino: rootStat.ino };
}
function event(key = hash, id = "evt-0001", createdAt = "2026-08-11T09:00:00.000Z"): JournalEvent {
  const value: Record<string, unknown> = {
    version: 1, kind: "apply", event_id: id, idempotency_key: key, created_at: createdAt,
    checkpoint: {
      version: 1, kind: "apply", source: { agent: "prime-agent", host_id: "casey", session_id: "sess-01", cwd: "/home/tester/atlas" }, project: { id: "atlas" },
      knowledge: { completed_tasks: [{ text: "Finished synthetic task", evidence: ["t1"] }], decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [] },
      evidence: { commits: [], tests: [{ id: "t1", value: "transaction.test.ts" }], files: [], deployments: [], observations: [] }, targets: { daily: true, project: false, landscape: false },
    }, planned_targets: [{ path: "Notas Diarias/2026-08-11.md", before_hash: null, after_hash: hash }],
  };
  return parseJournalEvent(value);
}
function appliedReceipt(id: string, key = hash, createdAt = "2026-08-11T09:01:00.000Z", note = ""): Record<string, unknown> {
  return { version: 1, outcome: "applied", event_id: id, idempotency_key: key, targets: [{ path: "Notas Diarias/2026-08-11.md", before_hash: null, after_hash: hash }], created_at: createdAt, ...(note.length > 0 ? { note } : {}) };
}

describe("JournalStore", () => {
  it("publishes schema-validated immutable event and receipt files in UTC YYYY-MM directories with private modes and redaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-")); roots.push(root);
    const store = new JournalStore({ vaultRoot: root, identity: await identity(root), now: () => "2026-08-11T09:00:00.000Z" });
    const written = await store.writeEvent(event());
    expect(written.kind).toBe("apply");
    expect(await store.readEvent("evt-0001")).toEqual(written);
    const eventPath = path.join(root, ".resyst", "journal", "2026-08", "evt-0001.json");
    const receiptPath = path.join(root, ".resyst", "receipts", "2026-08", "evt-0001.json");
    expect(await readdir(path.dirname(eventPath))).toContain("evt-0001.json");
    expect((await stat(eventPath)).mode & 0o777).toBe(0o600);
    const receipt = await store.writeReceipt(appliedReceipt("evt-0001"));
    expect((await store.findReceiptByIdempotency(hash))?.receipt).toEqual(receipt);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(await stat(receiptPath)).toBeTruthy();
    const rawReceipt = await readFile(receiptPath, "utf8");
    expect(rawReceipt).not.toContain("transaction.test.ts");
    expect(rawReceipt).not.toContain("/home/tester/atlas");
  });

  it("uses O_EXCL immutable records: identical event retries are stable while differing bytes reject", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-dup-")); roots.push(root);
    const store = new JournalStore({ vaultRoot: root, identity: await identity(root) });
    const first = await store.writeEvent(event());
    expect(await store.writeEvent(event())).toEqual(first);
    const conflicting = event(hash, "evt-0001");
    if (conflicting.kind !== "apply") throw new Error("fixture kind");
    conflicting.checkpoint.knowledge.completed_tasks[0]!.text = "Different bytes";
    await expect(store.writeEvent(conflicting)).rejects.toBeInstanceOf(JournalIntegrityError);
    const duplicate = await store.writeEvent(event(hash, "evt-0002"));
    expect(duplicate.event_id).toBe("evt-0002");
    await store.writeReceipt(appliedReceipt("evt-0001", hash, "2026-08-11T09:02:00.000Z"));
    const later = await store.writeReceipt(appliedReceipt("evt-0002", hash, "2026-08-11T09:01:00.000Z"));
    expect(later.event_id).toBe("evt-0002");
    expect((await store.findReceiptByIdempotency(hash))?.event_id).toBe("evt-0002");
  });

  it("bounds both valid and invalid journal months without mutating read-only scans", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-months-")); roots.push(root);
    const store = new JournalStore({ vaultRoot: root, identity: await identity(root) });
    await store.writeEvent(event());
    const journalRoot = path.join(root, ".resyst", "journal");
    const currentMonth = path.join(journalRoot, "2026-08");
    await chmod(journalRoot, 0o755);
    await chmod(currentMonth, 0o755);
    const rootMode = (await stat(journalRoot)).mode & 0o777;
    const monthMode = (await stat(currentMonth)).mode & 0o777;
    expect(await store.findEventByIdempotency(hash)).not.toBeNull();
    expect((await stat(journalRoot)).mode & 0o777).toBe(rootMode);
    expect((await stat(currentMonth)).mode & 0o777).toBe(monthMode);

    for (let year = 2000; year < 2020; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        await mkdir(path.join(journalRoot, `${year}-${String(month).padStart(2, "0")}`));
      }
    }
    await expect(store.findEventByIdempotency(hash)).rejects.toBeInstanceOf(JournalIntegrityError);

    const invalidRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-invalid-months-")); roots.push(invalidRoot);
    const invalidStore = new JournalStore({ vaultRoot: invalidRoot, identity: await identity(invalidRoot) });
    await invalidStore.writeEvent(event(hashB, "evt-invalid-months"));
    const invalidJournalRoot = path.join(invalidRoot, ".resyst", "journal");
    for (let index = 0; index < 241; index += 1) {
      await mkdir(path.join(invalidJournalRoot, `not-a-month-${index}`));
    }
    await expect(invalidStore.findEventByIdempotency(hashB)).rejects.toBeInstanceOf(JournalIntegrityError);
  });

  it("fails closed when a persisted event is corrupt, journal dirs are symlinked, or the trusted root is replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-corrupt-")); roots.push(root);
    const store = new JournalStore({ vaultRoot: root, identity: await identity(root) });
    await store.writeEvent(event());
    const file = path.join(root, ".resyst", "journal", "2026-08", "evt-0001.json");
    await writeFile(file, "{\"kind\":\"apply\"}", "utf8");
    await expect(store.readEvent("evt-0001")).rejects.toBeInstanceOf(JournalIntegrityError);

    const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-link-")); roots.push(symlinkRoot);
    const outside = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-outside-")); roots.push(outside);
    const trusted = await identity(symlinkRoot);
    await symlink(outside, path.join(symlinkRoot, ".resyst"));
    const unsafe = new JournalStore({ vaultRoot: symlinkRoot, identity: trusted });
    await expect(unsafe.writeEvent(event(hashB, "evt-link"))).rejects.toBeInstanceOf(JournalIntegrityError);

    const replacedRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-journal-replaced-")); roots.push(replacedRoot);
    const replacedIdentity = await identity(replacedRoot);
    const replacedStore = new JournalStore({ vaultRoot: replacedRoot, identity: replacedIdentity });
    await rename(replacedRoot, `${replacedRoot}-old`);
    roots.push(`${replacedRoot}-old`);
    await mkdir(replacedRoot);
    await expect(replacedStore.writeEvent(event(hashB, "evt-replaced"))).rejects.toBeInstanceOf(JournalIntegrityError);
  });
});
