import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalLock,
  LockIntegrityError,
  LockTimeoutError,
  type LockOwner,
} from "../../src/lock.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function options(root: string, overrides: Record<string, unknown> = {}) {
  return {
    stateRoot: root,
    pid: 321,
    processStart: "start-321",
    timeoutMs: 30,
    retryMs: 1,
    ...overrides,
  };
}

describe("LocalLock", () => {
  it("serializes owners and times out while a live owner holds the lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-"));
    roots.push(root);
    const first = new LocalLock(options(root, { isOwnerLive: async () => true, now: () => "2020-01-01T00:00:00.000Z" }));
    const second = new LocalLock(options(root, {
      pid: 654,
      processStart: "start-654",
      isOwnerLive: async () => true,
    }));
    const held = await first.acquire();
    await expect(second.acquire()).rejects.toBeInstanceOf(LockTimeoutError);
    // The owner is old but still live: timeout must not break it by age.
    const persisted = JSON.parse(await readFile(held.path, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ process_start: "start-321", acquired_at: "2020-01-01T00:00:00.000Z" });
    expect(new Date(String(persisted.acquired_at)).getTime()).toBeLessThan(Date.now());
    await held.release();
    const next = await second.acquire();
    await next.release();
    expect(await readdir(path.dirname(held.path))).not.toContain("write.lock");
  });

  it("recovers a real abandoned record only after PID/start identity proves it dead", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-abandoned-"));
    roots.push(root);
    const stale = new LocalLock(options(root, {
      pid: 77,
      processStart: "new-start",
      isOwnerLive: async (candidate: LockOwner) => candidate.pid === 77 ? false : "unknown",
    }));
    await mkdir(path.dirname(stale.path), { recursive: true });
    const oldOwner: LockOwner = {
      version: 1,
      pid: 77,
      process_start: "old-start",
      acquired_at: "2020-01-01T00:00:00.000Z",
    };
    await writeFile(stale.path, JSON.stringify(oldOwner), { mode: 0o600 });
    const recovered = await stale.acquire();
    expect(JSON.parse(await readFile(recovered.path, "utf8"))).toMatchObject({
      pid: 77,
      process_start: "new-start",
    });
    await recovered.release();
  });

  it("fails closed when process liveness cannot be established", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-unknown-"));
    roots.push(root);
    const first = new LocalLock(options(root, { isOwnerLive: async () => true, now: () => "2020-01-01T00:00:00.000Z" }));
    const held = await first.acquire();
    const second = new LocalLock(options(root, {
      pid: 999,
      processStart: "other",
      isOwnerLive: async () => "unknown",
    }));
    await expect(second.acquire()).rejects.toBeInstanceOf(LockTimeoutError);
    await held.release();
  });

  it("rejects empty, oversized, and control-character process identities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-process-start-"));
    roots.push(root);
    await expect(new LocalLock(options(root, { processStart: "" })).acquire()).rejects.toBeInstanceOf(LockIntegrityError);
    await expect(new LocalLock(options(root, { processStart: "x".repeat(257) })).acquire()).rejects.toBeInstanceOf(LockIntegrityError);
    await expect(new LocalLock(options(root, { processStart: "bad\nstart" })).acquire()).rejects.toBeInstanceOf(LockIntegrityError);
  });

  it("retries a temporary-name EEXIST without treating it as final contention", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-temp-collision-"));
    roots.push(root);
    let suffix = "collision";
    const lock = new LocalLock(options(root, {
      timeoutMs: 1000,
      retryMs: 0,
      tempName: () => {
        const current = suffix;
        suffix = "fresh";
        return current;
      },
    }));
    await mkdir(path.dirname(lock.path), { recursive: true });
    const foreignTemporary = `${lock.path}.tmp-321-collision`;
    await writeFile(foreignTemporary, "foreign", { mode: 0o600 });
    const held = await lock.acquire();
    expect(await readFile(foreignTemporary, "utf8")).toBe("foreign");
    await held.release();
  });

  it("survives publication churn without leaving temporary lock names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-churn-"));
    roots.push(root);
    const lock = new LocalLock(options(root, { timeoutMs: 1000, retryMs: 0 }));
    for (let index = 0; index < 32; index += 1) {
      const held = await lock.acquire();
      await held.release();
    }
    const names = await readdir(path.dirname(lock.path));
    expect(names.filter((name) => name.includes(".tmp-") || name.includes(".tmp"))).toEqual([]);
  });

  it("does not release a lock record replaced by another owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-replaced-"));
    roots.push(root);
    const lock = new LocalLock(options(root));
    const held = await lock.acquire();
    const replacement: LockOwner = {
      version: 1,
      pid: 987,
      process_start: "replacement",
      acquired_at: "2026-08-12T00:00:00.000Z",
    };
    const temporary = `${held.path}.replacement`;
    await writeFile(temporary, JSON.stringify(replacement), { mode: 0o600 });
    await rename(temporary, held.path);
    await expect(held.release()).rejects.toBeInstanceOf(LockIntegrityError);
    expect(JSON.parse(await readFile(held.path, "utf8"))).toEqual(replacement);
  });

  it("rejects a symlinked lock directory and cleans publication temps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-symlink-"));
    roots.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-outside-"));
    roots.push(outside);
    await mkdir(path.join(root, "resyst-vault"));
    await symlink(outside, path.join(root, "resyst-vault", "locks"));
    const unsafe = new LocalLock(options(root));
    await expect(unsafe.acquire()).rejects.toBeInstanceOf(LockIntegrityError);

    const safeRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-lock-clean-"));
    roots.push(safeRoot);
    const safe = new LocalLock(options(safeRoot));
    const held = await safe.acquire();
    const names = await readdir(path.dirname(held.path));
    expect(names.some((name) => name.includes(".tmp-") || name.includes(".tmp"))).toBe(false);
    await held.release();
  });
});
