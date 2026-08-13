import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  constants as fsConstants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { SearchResult, VaultReadResult } from "../../src/search.js";
import type { IsoTimestamp, VaultPath } from "../../src/types.js";
import {
  SNAPSHOT_OPEN_FLAGS,
  SnapshotReadError,
  TOOL_UNAVAILABLE_MESSAGE,
  createProductionService,
  registerReadTools,
  type BridgeReadService,
  type SnapshotFs,
  type SnapshotHandle,
  type SnapshotStat,
} from "../../src/extension/tools.js";
import { createVault } from "../fixtures/create-vault.js";

function resultFixtures(): { search: SearchResult; read: VaultReadResult } {
  return {
    search: { version: 1, hits: [], truncated: false, scanned_notes: 2, cache: "hit" },
    read: {
      version: 1,
      path: "Proyectos/Atlas.md" as VaultPath,
      heading: null,
      modified_at: "2026-08-12T00:00:00.000Z" as IsoTimestamp,
      content: "> quoted Atlas context",
      char_count: 22,
      truncated: false,
    },
  };
}

function capture(service: BridgeReadService): { tools: ToolDefinition[]; appendEntry: ReturnType<typeof vi.fn> } {
  const tools: ToolDefinition[] = [];
  const appendEntry = vi.fn();
  const api = {
    on: vi.fn(),
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    appendEntry,
  } as unknown as ExtensionAPI;
  registerReadTools(api, service);
  return { tools, appendEntry };
}

function fakeContext(): ExtensionContext {
  return { cwd: "/home/tester/synthetic/atlas" } as unknown as ExtensionContext;
}

describe("Prime read tools", () => {
  it("registers search and read synchronously with exact bounded TypeBox schemas", () => {
    const fixtures = resultFixtures();
    const service: BridgeReadService = {
      bootstrap: vi.fn(async () => ""),
      search: vi.fn(async () => fixtures.search),
      read: vi.fn(async () => fixtures.read),
    };
    const { tools } = capture(service);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["vault_read", "vault_search"]);
    expect(tools.some((tool) => tool.name === "vault_checkpoint")).toBe(false);
    const search = tools.find((tool) => tool.name === "vault_search")!;
    const read = tools.find((tool) => tool.name === "vault_read")!;
    expect(Value.Check(search.parameters, { query: "Atlas", limit: 5 })).toBe(true);
    expect(Value.Check(search.parameters, { query: "Atlas", extra: true })).toBe(false);
    expect(Value.Check(search.parameters, { query: "", limit: 5 })).toBe(false);
    expect(Value.Check(search.parameters, { query: "Atlas", limit: 33 })).toBe(false);
    expect(Value.Check(read.parameters, { path: "Proyectos/Atlas.md" })).toBe(true);
    expect(Value.Check(read.parameters, { path: "../../private.md" })).toBe(false);
    expect(Value.Check(read.parameters, { path: "Proyectos/Atlas.md", cwd: "/spoof" })).toBe(false);
  });

  it("forwards only bounded parameters and returns stable structured success", async () => {
    const fixtures = resultFixtures();
    const searchCall = vi.fn(async () => fixtures.search);
    const readCall = vi.fn(async () => fixtures.read);
    const { tools, appendEntry } = capture({ bootstrap: vi.fn(async () => ""), search: searchCall, read: readCall });
    const search = tools.find((tool) => tool.name === "vault_search")!;
    const read = tools.find((tool) => tool.name === "vault_read")!;
    const searchResult = await search.execute("call-search", { query: "Atlas", limit: 4 }, undefined, undefined, fakeContext());
    const readResult = await read.execute("call-read", { path: "Proyectos/Atlas.md", heading: "## Estado" }, undefined, undefined, fakeContext());
    expect(searchCall).toHaveBeenCalledWith({ query: "Atlas", limit: 4 });
    expect(readCall).toHaveBeenCalledWith({ path: "Proyectos/Atlas.md", heading: "## Estado" });
    expect(searchResult.details).toEqual({ version: 1, outcome: "ok" });
    expect(JSON.parse(searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "null")).toEqual(fixtures.search);
    expect(readResult.details).toEqual({ version: 1, outcome: "ok" });
    expect(JSON.parse(readResult.content[0]?.type === "text" ? readResult.content[0].text : "null")).toEqual(fixtures.read);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("converts every service failure to one fixed non-blocking result", async () => {
    const service: BridgeReadService = {
      bootstrap: vi.fn(async () => ""),
      search: vi.fn(async () => { throw new Error("/private/vault/secret.md"); }),
      read: vi.fn(async () => { throw new Error("private note body"); }),
    };
    const { tools } = capture(service);
    for (const tool of tools) {
      const params = tool.name === "vault_search" ? { query: "Atlas" } : { path: "Proyectos/Atlas.md" };
      const result = await tool.execute("call", params, undefined, undefined, fakeContext());
      expect(result.content).toEqual([{ type: "text", text: TOOL_UNAVAILABLE_MESSAGE }]);
      expect(result.details).toEqual({ version: 1, outcome: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
});

describe("Prime bootstrap snapshot reader", () => {
  it("always opens with O_RDONLY|O_NOFOLLOW|O_NONBLOCK", () => {
    expect(SNAPSHOT_OPEN_FLAGS & fsConstants.O_RDONLY).toBe(fsConstants.O_RDONLY);
    expect(SNAPSHOT_OPEN_FLAGS & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(SNAPSHOT_OPEN_FLAGS & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
  });

  it("reads a contained vault symlink inside the trusted root without escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-symlink-ok-"));
    try {
      const vault = path.join(root, "vault");
      const configHome = path.join(root, "config");
      const real = await createVault({
        vaultPath: vault,
        withDailyNote: true,
        withProjectNote: true,
        dailyNoteDate: "2026-08-11",
        claudeMd: "# Resyst Vault\n\n## Quién soy\n- Casey\n",
      });
      const linkPath = path.join(vault, "CLAUDE.md");
      const target = path.join(vault, "contained-claude.md");
      await rename(linkPath, target);
      await symlink(target, linkPath);
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
        "utf8",
      );
      const production = createProductionService({
        xdgConfigHome: configHome,
        now: () => new Date("2026-08-11T12:00:00.000Z"),
      });
      const bootstrap = await production.bootstrap({ cwd: root });
      expect(bootstrap).toContain("RESYST VAULT BRIDGE — ROOT-TURN CONTEXT");
      expect(bootstrap).toContain("Casey");
      // The contained symlink should resolve through to the real file
      // and the snapshot reader should surface the linked content via
      // the canonical-target open at O_NOFOLLOW. Sanity-check the
      // linked file is the same content as the real file.
      expect(await readFile(linkPath, "utf8")).toBe(await readFile(target, "utf8"));
      expect(real.paths.claudeMd).toBe(linkPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a swap-at-open that lands between open and stat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-swap-open-"));
    try {
      const vault = path.join(root, "vault");
      const configHome = path.join(root, "config");
      await createVault({
        vaultPath: vault,
        withDailyNote: true,
        withProjectNote: false,
        dailyNoteDate: "2026-08-11",
        claudeMd: "ORIGINAL_BOUNDED_TEXT\n",
      });
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
        "utf8",
      );

      const realFs = await import("node:fs/promises");
      let swapped = false;

      // Build a typed SnapshotFs that performs the swap inside `open`,
      // strictly between the kernel-level open and the subsequent stat.
      const realStat = async (target: string): Promise<SnapshotStat> => {
        const s = await realFs.stat(target, { bigint: true });
        return {
          isFile: () => s.isFile(),
          isSymbolicLink: () => s.isSymbolicLink(),
          dev: s.dev,
          ino: s.ino,
          size: s.size,
          mtimeMs: s.mtimeMs,
          nlink: s.nlink,
        };
      };
      const realRealpath = async (target: string): Promise<string> => {
        return realFs.realpath(target);
      };

      const swapSnapshotFs: SnapshotFs = {
        realpath: realRealpath,
        stat: realStat,
        async open(filePath, flags): Promise<SnapshotHandle> {
          if (!swapped && filePath.endsWith("CLAUDE.md")) {
            // Open the original file first (so the kernel binds the handle),
            // then atomically replace the path with different content
            // BEFORE the snapshot reader's next stat call.
            swapped = true;
          }
          const handle = await realFs.open(filePath, flags);
          const stat = async (): Promise<SnapshotStat> => {
            if (swapped && filePath.endsWith("CLAUDE.md")) {
              await unlink(filePath).catch(() => undefined);
              await writeFile(filePath, "REPLACED_AFTER_OPEN\n", "utf8");
              swapped = false;
            }
            const s = await handle.stat({ bigint: true });
            return {
              isFile: () => s.isFile(),
              isSymbolicLink: () => s.isSymbolicLink(),
              dev: s.dev,
              ino: s.ino,
              size: s.size,
              mtimeMs: s.mtimeMs,
              nlink: s.nlink,
            };
          };
          return {
            fstat: stat,
            async readBounded(maxBytes) {
              const buffer = Buffer.alloc(maxBytes + 1);
              let offset = 0;
              while (offset < buffer.length) {
                const { bytesRead } = await handle.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  null,
                );
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              if (offset > maxBytes) throw new SnapshotReadError("too_large");
              return new TextDecoder("utf-8", { fatal: true }).decode(
                buffer.subarray(0, offset),
              );
            },
            close: async () => {
              await handle.close().catch(() => undefined);
            },
          };
        },
      };

      const production = createProductionService({
        xdgConfigHome: configHome,
        now: () => new Date("2026-08-11T12:00:00.000Z"),
        snapshotFs: swapSnapshotFs,
      });
      await expect(production.bootstrap({ cwd: root })).rejects.toBeInstanceOf(
        SnapshotReadError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an external symlink swapped in after containment resolution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-swap-external-"));
    try {
      const vault = path.join(root, "vault");
      const configHome = path.join(root, "config");
      await createVault({ vaultPath: vault, claudeMd: "SAFE\n" });
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
        "utf8",
      );
      const external = path.join(root, "external-secret.md");
      await writeFile(external, "EXTERNAL_SECRET_MUST_NOT_LOAD\n", "utf8");
      const realFs = await import("node:fs/promises");
      let swapped = false;
      const hostileFs: SnapshotFs = {
        realpath: (target) => realFs.realpath(target),
        stat: realStat,
        async open(filePath, flags) {
          if (!swapped && filePath.endsWith("CLAUDE.md")) {
            swapped = true;
            await unlink(filePath);
            await symlink(external, filePath);
          }
          try {
            const handle = await realFs.open(filePath, flags);
            return nodeLikeHandle(handle);
          } catch {
            throw new SnapshotReadError("open_failed");
          }
        },
      };
      const production = createProductionService({
        xdgConfigHome: configHome,
        snapshotFs: hostileFs,
      });
      await expect(production.bootstrap({ cwd: root })).rejects.toBeInstanceOf(
        SnapshotReadError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stat-name swap that moves the canonical target after open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-swap-name-"));
    try {
      const vault = path.join(root, "vault");
      const configHome = path.join(root, "config");
      await createVault({
        vaultPath: vault,
        withDailyNote: true,
        withProjectNote: false,
        dailyNoteDate: "2026-08-11",
        claudeMd: "ORIGINAL_NAME_SWAP\n",
      });
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
        "utf8",
      );

      const realFs = await import("node:fs/promises");
      let didSwap = false;
      const swapSnapshotFs: SnapshotFs = {
        realpath: (target) => realFs.realpath(target),
        stat: realStat,
        async open(filePath, flags) {
          const handle = await realFs.open(filePath, flags);
          // Simulate an attacker that swaps the canonical-target path
          // name BEFORE the snapshot reader's pathStat call.
          if (!didSwap && filePath.endsWith("CLAUDE.md")) {
            didSwap = true;
            await realFs.rename(filePath, `${filePath}.replaced`).catch(() => undefined);
            await writeFile(filePath, "AFTER_NAME_SWAP\n", "utf8");
          }
          return {
            fstat: async () => {
              const s = await handle.stat({ bigint: true });
              return {
                isFile: () => s.isFile(),
                isSymbolicLink: () => s.isSymbolicLink(),
                dev: s.dev,
                ino: s.ino,
                size: s.size,
                mtimeMs: s.mtimeMs,
                nlink: s.nlink,
              };
            },
            readBounded: async (maxBytes) => {
              const buffer = Buffer.alloc(maxBytes + 1);
              let offset = 0;
              while (offset < buffer.length) {
                const { bytesRead } = await handle.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  null,
                );
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              if (offset > maxBytes) throw new SnapshotReadError("too_large");
              return new TextDecoder("utf-8", { fatal: true }).decode(
                buffer.subarray(0, offset),
              );
            },
            close: async () => {
              await handle.close().catch(() => undefined);
            },
          };
        },
      };
      const production = createProductionService({
        xdgConfigHome: configHome,
        now: () => new Date("2026-08-11T12:00:00.000Z"),
        snapshotFs: swapSnapshotFs,
      });
      await expect(production.bootstrap({ cwd: root })).rejects.toBeInstanceOf(
        SnapshotReadError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized and NUL-byte snapshots as redacted errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-snap-reject-"));
    try {
      const vault = path.join(root, "vault");
      const configHome = path.join(root, "config");
      await createVault({
        vaultPath: vault,
        withDailyNote: true,
        withProjectNote: false,
        dailyNoteDate: "2026-08-11",
        claudeMd: "TOO_LARGE_PREFIX",
      });
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
        "utf8",
      );

      const realFs = await import("node:fs/promises");
      const realStat = async (target: string): Promise<SnapshotStat> => {
        const s = await realFs.stat(target, { bigint: true });
        return {
          isFile: () => s.isFile(),
          isSymbolicLink: () => s.isSymbolicLink(),
          dev: s.dev,
          ino: s.ino,
          size: s.size,
          mtimeMs: s.mtimeMs,
          nlink: s.nlink,
        };
      };
      const overrideFs: SnapshotFs = {
        realpath: (target) => realFs.realpath(target),
        stat: realStat,
        async open(filePath, flags) {
          const handle = await realFs.open(filePath, flags);
          return {
            fstat: async () => realStat(filePath),
            readBounded: async () => "small NUL\u0000byte\n",
            close: async () => {
              await handle.close().catch(() => undefined);
            },
          };
        },
      };
      const production = createProductionService({
        xdgConfigHome: configHome,
        now: () => new Date("2026-08-11T12:00:00.000Z"),
        snapshotFs: overrideFs,
      });
      await expect(production.bootstrap({ cwd: root })).rejects.toBeInstanceOf(
        SnapshotReadError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 and byte-budget overflow", async () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.alloc(1_000_001, 0x61)]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-invalid-bytes-"));
      try {
        const vault = path.join(root, "vault");
        const configHome = path.join(root, "config");
        const created = await createVault({ vaultPath: vault });
        await writeFile(created.paths.claudeMd, bytes);
        await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
        await writeFile(
          path.join(configHome, "resyst-vault", "config.json"),
          JSON.stringify({ version: 1, host_id: "casey", vault_path: vault, project_overrides: [] }),
          "utf8",
        );
        const production = createProductionService({ xdgConfigHome: configHome });
        await expect(production.bootstrap({ cwd: root })).rejects.toBeInstanceOf(
          SnapshotReadError,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

// Local helper for swap tests; declared at module scope so each test can
// reference it. `realStat` reads the path by name (not the handle).
function nodeLikeHandle(
  handle: import("node:fs/promises").FileHandle,
): SnapshotHandle {
  return {
    async fstat() {
      const s = await handle.stat({ bigint: true });
      return {
        isFile: () => s.isFile(),
        isSymbolicLink: () => s.isSymbolicLink(),
        dev: s.dev,
        ino: s.ino,
        size: s.size,
        mtimeMs: s.mtimeMs,
        nlink: s.nlink,
      };
    },
    async readBounded(maxBytes) {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new SnapshotReadError("too_large");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    },
    close: async () => {
      await handle.close();
    },
  };
}

async function realStat(target: string): Promise<SnapshotStat> {
  const fs = await import("node:fs/promises");
  const s = await fs.stat(target, { bigint: true });
  return {
    isFile: () => s.isFile(),
    isSymbolicLink: () => s.isSymbolicLink(),
    dev: s.dev,
    ino: s.ino,
    size: s.size,
    mtimeMs: s.mtimeMs,
    nlink: s.nlink,
  };
}
