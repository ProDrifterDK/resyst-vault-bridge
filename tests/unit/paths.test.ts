/**
 * Unit tests for the `VaultPaths` containment/symlink boundary
 * (`src/paths.ts`).
 *
 * Every test builds a synthetic vault through `tests/fixtures/create-vault.ts`
 * in a throwaway temp directory and injects the filesystem seam, so the real
 * vault is never read or written. Lexical checks run before any IO; realpath
 * containment checks run for existing parents and targets.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  nodeVaultPathsFs,
  VaultPathError,
  VaultPaths,
  type ResolvedVaultPath,
  type VaultRootIdentity,
  type VaultPathsFs,
} from "../../src/paths.js";
import type { VaultPath } from "../../src/types.js";
import { createVault, type CreatedVault } from "../fixtures/create-vault.js";

interface PathsContext {
  root: string;
  vault: CreatedVault;
  paths: VaultPaths;
  /** Config-validated identity of the fixture vault (captured at setup). */
  identity: VaultRootIdentity;
  /** Absolute path of a file outside the vault, for escape fixtures. */
  outsideFile: string;
  /** Absolute path of a directory outside the vault, for escape fixtures. */
  outsideDir: string;
}

/** Capture the config-style identity of a vault root (realpath + dev/ino). */
async function vaultIdentityOf(vaultPath: string): Promise<VaultRootIdentity> {
  const real = await realpath(vaultPath);
  const rootStat = await stat(vaultPath);
  return { real_path: real, dev: rootStat.dev, ino: rootStat.ino };
}

async function withPaths<T>(
  body: (ctx: PathsContext) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-paths-test-"));
  try {
    const vault = await createVault({ vaultPath: path.join(root, "vault") });
    const outsideFile = path.join(root, "outside.md");
    await writeFile(outsideFile, "# outside\n", "utf8");
    const outsideDir = path.join(root, "outside-dir");
    await mkdir(outsideDir);
    const identity = await vaultIdentityOf(vault.vaultPath);
    const paths = new VaultPaths(vault.vaultPath, {
      identity,
      attachmentsDir: vault.layout.attachmentsDir,
      fs: nodeVaultPathsFs,
    });
    return await body({ root, vault, paths, identity, outsideFile, outsideDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Capture the VaultPathError thrown by a resolver, if any. */
async function capture(
  run: () => Promise<unknown>,
): Promise<VaultPathError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(VaultPathError);
    return error as VaultPathError;
  }
}

/** Build a Node-style error with a stable `code`, echoing only a fake path. */
function nodeError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${filePath}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Wrap the node paths seam, failing calls that match `failWhen`. */
function failingPathsFs(
  failWhen: (method: "realpath" | "stat" | "lstat", filePath: string) => boolean,
  code: string,
): VaultPathsFs {
  return {
    realpath: async (filePath) => {
      if (failWhen("realpath", filePath)) throw nodeError(code, filePath);
      return nodeVaultPathsFs.realpath(filePath);
    },
    stat: async (filePath) => {
      if (failWhen("stat", filePath)) throw nodeError(code, filePath);
      return nodeVaultPathsFs.stat(filePath);
    },
    lstat: async (filePath) => {
      if (failWhen("lstat", filePath)) throw nodeError(code, filePath);
      return nodeVaultPathsFs.lstat(filePath);
    },
  };
}

/** Track calls and report the write target as a non-regular file. */
function nonRegularTargetFs(
  targetAbs: string,
): { fs: VaultPathsFs; realpathCalls: string[] } {
  const realpathCalls: string[] = [];
  return {
    realpathCalls,
    fs: {
      realpath: async (filePath) => {
        realpathCalls.push(filePath);
        return nodeVaultPathsFs.realpath(filePath);
      },
      stat: async (filePath) => nodeVaultPathsFs.stat(filePath),
      lstat: async (filePath) => {
        if (filePath === targetAbs) {
          return {
            isFile: () => false,
            isDirectory: () => false,
            isSymbolicLink: () => false,
            dev: 0,
            ino: 0,
          };
        }
        return nodeVaultPathsFs.lstat(filePath);
      },
    },
  };
}

describe("VaultPaths: accepted normalized Markdown paths", () => {
  it("accepts a contained root note for reads", async () => {
    await withPaths(async (ctx) => {
      const resolved = await ctx.paths.resolveRead("CLAUDE.md");
      expect(resolved.vaultRelative).toBe("CLAUDE.md");
      expect(resolved.absolute).toBe(ctx.vault.paths.claudeMd);
      expectTypeOf(resolved.vaultRelative).toEqualTypeOf<VaultPath>();
      expectTypeOf(resolved).toEqualTypeOf<ResolvedVaultPath>();
    });
  });

  it("accepts a nested contained note for reads", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.writeNote("Proyectos/Atlas/Notas.md", "# Notas\n");
      const resolved = await ctx.paths.resolveRead("Proyectos/Atlas/Notas.md");
      expect(resolved.vaultRelative).toBe("Proyectos/Atlas/Notas.md");
      expect(resolved.absolute).toBe(
        ctx.vault.absolute("Proyectos/Atlas/Notas.md"),
      );
    });
  });

  it("accepts paths with spaces and unicode segments", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.writeNote("Notas Diarias/2026-08-11.md", "# día\n");
      const resolved = await ctx.paths.resolveRead("Notas Diarias/2026-08-11.md");
      expect(resolved.vaultRelative).toBe("Notas Diarias/2026-08-11.md");
    });
  });

  it("accepts a write to a new note under an existing directory", async () => {
    await withPaths(async (ctx) => {
      const resolved = await ctx.paths.resolveWrite("Notas Diarias/2026-08-12.md");
      expect(resolved.absolute).toBe(ctx.vault.dailyNoteAbsolute("2026-08-12"));
    });
  });

  it("accepts a write to an existing regular file", async () => {
    await withPaths(async (ctx) => {
      const resolved = await ctx.paths.resolveWrite("CLAUDE.md");
      expect(resolved.absolute).toBe(ctx.vault.paths.claudeMd);
    });
  });

  it("accepts a read through a symlink that stays inside the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Alias.md", ctx.vault.paths.claudeMd);
      const resolved = await ctx.paths.resolveRead("Alias.md");
      expect(resolved.vaultRelative).toBe("Alias.md");
    });
  });
});

describe("VaultPaths: lexical containment before IO", () => {
  it("rejects traversal segments without touching the filesystem target", async () => {
    await withPaths(async (ctx) => {
      const bad = ["../escape.md", "a/../../b.md", "Proyectos/../CLAUDE.md", ".."];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveRead(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("traversal");
        expect(err?.message).not.toContain("..");
      }
    });
  });

  it("rejects absolute and backslash note references", async () => {
    await withPaths(async (ctx) => {
      const bad = ["/etc/passwd", "/Proyectos/Atlas.md", "a\\b.md", "\\server\share.md"];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveRead(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("not_relative");
      }
    });
  });

  it("rejects non-Markdown note references", async () => {
    await withPaths(async (ctx) => {
      const bad = ["CLAUDE", "README.txt", "x.MD", "Notas Diarias/2026-08-11", "a.md.txt"];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveRead(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("not_markdown");
      }
    });
  });

  it("rejects non-normalized paths: doubled/trailing slashes and control characters", async () => {
    await withPaths(async (ctx) => {
      const bad = ["a//b.md", "a/b.md/", "a/b.md//", "a\u0000b.md", "a\tb.md"];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveRead(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("malformed");
      }
    });
  });

  it("rejects an empty path", async () => {
    await withPaths(async (ctx) => {
      const err = await capture(() => ctx.paths.resolveRead(""));
      expect(err).toBeDefined();
      expect(err?.code).toBe("empty");
    });
  });

  it("rejects overlong paths", async () => {
    await withPaths(async (ctx) => {
      const long = `${"x".repeat(1024)}.md`;
      const err = await capture(() => ctx.paths.resolveRead(long));
      expect(err).toBeDefined();
      expect(err?.code).toBe("malformed");
    });
  });
});

describe("VaultPaths: reserved internals", () => {
  it("rejects .resyst, .stfolder, and .git segments", async () => {
    await withPaths(async (ctx) => {
      const bad = [
        ".resyst/agent-vault.yaml.md",
        ".resyst/journal/x.md",
        ".resyst/receipts/x.md",
        ".stfolder/x.md",
        ".git/x.md",
        "Proyectos/.git/x.md",
        "Inbox/.stfolder/x.md",
      ];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveRead(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("reserved");
      }
    });
  });

  it("rejects reserved internals for writes as well", async () => {
    await withPaths(async (ctx) => {
      const bad = [".resyst/journal/x.md", ".git/x.md", ".stfolder/x.md"];
      for (const input of bad) {
        const err = await capture(() => ctx.paths.resolveWrite(input));
        expect(err, input).toBeDefined();
        expect(err?.code, input).toBe("reserved");
      }
    });
  });
});

describe("VaultPaths: _adjuntos automatic read exclusion", () => {
  it("rejects automatic reads under the attachments directory", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.writeNote("_adjuntos/photo.md", "binary-ish\n");
      const err = await capture(() =>
        ctx.paths.resolveRead("_adjuntos/photo.md", { automatic: true }),
      );
      expect(err).toBeDefined();
      expect(err?.code).toBe("attachments_automatic");
    });
  });

  it("allows explicit reads under the attachments directory", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.writeNote("_adjuntos/photo.md", "explicit attachment\n");
      const resolved = await ctx.paths.resolveRead("_adjuntos/photo.md");
      expect(resolved.vaultRelative).toBe("_adjuntos/photo.md");
    });
  });

  it("does not exclude notes outside the configured attachments directory", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.writeNote("Adjuntos/photo.md", "not attachments\n");
      const resolved = await ctx.paths.resolveRead("Adjuntos/photo.md", {
        automatic: true,
      });
      expect(resolved.vaultRelative).toBe("Adjuntos/photo.md");
    });
  });
});

describe("VaultPaths: symlink escape and symlinked write targets", () => {
  it("rejects a read whose target symlink escapes the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Escapes.md", ctx.outsideFile);
      const err = await capture(() => ctx.paths.resolveRead("Escapes.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a read through a symlinked directory that escapes the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Linked", ctx.outsideDir);
      const err = await capture(() => ctx.paths.resolveRead("Linked/note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a write whose parent directory escapes the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Linked", ctx.outsideDir);
      const err = await capture(() => ctx.paths.resolveWrite("Linked/new.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a write to a symlinked target even when it stays inside the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Linked.md", ctx.vault.paths.claudeMd);
      const err = await capture(() => ctx.paths.resolveWrite("Linked.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_target");
    });
  });

  it("rejects a write to a target whose real path escapes the vault", async () => {
    await withPaths(async (ctx) => {
      await ctx.vault.createSymlink("Escapes.md", ctx.outsideFile);
      const err = await capture(() => ctx.paths.resolveWrite("Escapes.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });
});

describe("VaultPaths: existence and directory checks", () => {
  it("rejects a read of a missing note", async () => {
    await withPaths(async (ctx) => {
      const err = await capture(() => ctx.paths.resolveRead("NoSuch.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_missing");
    });
  });

  it("rejects a read of a directory-shaped target", async () => {
    await withPaths(async (ctx) => {
      await mkdir(ctx.vault.absolute("Proyectos/Dir.md"));
      const err = await capture(() => ctx.paths.resolveRead("Proyectos/Dir.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_not_file");
    });
  });

  it("rejects a read through a symlink that resolves to a directory", async () => {
    await withPaths(async (ctx) => {
      await mkdir(ctx.vault.absolute("Dir.md"));
      await ctx.vault.createSymlink("Linked.md", ctx.vault.absolute("Dir.md"));
      const err = await capture(() => ctx.paths.resolveRead("Linked.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_not_file");
    });
  });

  it("rejects a write whose immediate parent does not exist", async () => {
    await withPaths(async (ctx) => {
      const err = await capture(() => ctx.paths.resolveWrite("NoSuchDir/Child.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("parent_missing");
    });
  });

  it("rejects a write whose parent is a file", async () => {
    await withPaths(async (ctx) => {
      const err = await capture(() => ctx.paths.resolveWrite("CLAUDE.md/child.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("parent_not_directory");
    });
  });

  it("rejects a write to an existing directory", async () => {
    await withPaths(async (ctx) => {
      await mkdir(ctx.vault.absolute("Proyectos/Dir.md"));
      const err = await capture(() => ctx.paths.resolveWrite("Proyectos/Dir.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_is_directory");
    });
  });
});

describe("VaultPaths: error redaction and fixed messages", () => {
  it("never echoes the input path or the vault path in errors", async () => {
    await withPaths(async (ctx) => {
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["../secret-escape.md", () => ctx.paths.resolveRead("../secret-escape.md")],
        ["/home/tester/Secret.md", () => ctx.paths.resolveRead("/home/tester/Secret.md")],
        [".resyst/secret.md", () => ctx.paths.resolveRead(".resyst/secret.md")],
      ];
      for (const [input, run] of cases) {
        const err = await capture(run);
        expect(err, input).toBeDefined();
        expect(err?.message, input).not.toContain(input);
        expect(err?.message, input).not.toContain("secret");
        expect(err?.message, input).not.toContain(ctx.vault.vaultPath);
        expect(JSON.stringify(err), input).not.toContain(ctx.vault.vaultPath);
      }
    });
  });

  it("produces a stable fixed message per code", async () => {
    await withPaths(async (ctx) => {
      const a = await capture(() => ctx.paths.resolveRead("../x.md"));
      const b = await capture(() => ctx.paths.resolveRead("../../x.md"));
      expect(a?.message).toBe(b?.message);
      expect(a?.message).toMatch(/^vault path /);
    });
  });
});

describe("VaultPaths: filesystem failures are redacted", () => {
  const ioCodes = ["EACCES", "EIO"] as const;

  for (const code of ioCodes) {
    it(`maps ${code} on the vault root realpath to io_error for reads and writes`, async () => {
      await withPaths(async (ctx) => {
        const fs = failingPathsFs(
          (method, filePath) => method === "realpath" && filePath === ctx.vault.vaultPath,
          code,
        );
        const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs });
        const readErr = await capture(() => paths.resolveRead("CLAUDE.md"));
        expect(readErr, code).toBeDefined();
        expect(readErr?.code, code).toBe("io_error");
        const writeErr = await capture(() => paths.resolveWrite("CLAUDE.md"));
        expect(writeErr, code).toBeDefined();
        expect(writeErr?.code, code).toBe("io_error");
      });
    });

    it(`maps ${code} at every read seam to io_error`, async () => {
      await withPaths(async (ctx) => {
        await ctx.vault.writeNote("Proyectos/Atlas.md", "# Atlas\n");
        const seams: Array<{
          label: string;
          failWhen: (method: "realpath" | "stat" | "lstat", filePath: string) => boolean;
        }> = [
          {
            label: "parent realpath",
            failWhen: (m, f) => m === "realpath" && f === ctx.vault.absolute("Proyectos"),
          },
          {
            label: "target realpath",
            failWhen: (m, f) => m === "realpath" && f === ctx.vault.absolute("Proyectos/Atlas.md"),
          },
          {
            label: "target lstat",
            failWhen: (m, f) => m === "lstat" && f === ctx.vault.absolute("Proyectos/Atlas.md"),
          },
          {
            label: "target stat",
            failWhen: (m, f) => m === "stat" && f === ctx.vault.absolute("Proyectos/Atlas.md"),
          },
        ];
        for (const seam of seams) {
          const fs = failingPathsFs(seam.failWhen, code);
          const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs });
          const err = await capture(() => paths.resolveRead("Proyectos/Atlas.md"));
          expect(err, `${code}:${seam.label}`).toBeDefined();
          expect(err?.code, `${code}:${seam.label}`).toBe("io_error");
          expect(err?.message, `${code}:${seam.label}`).not.toContain(ctx.vault.vaultPath);
        }
      });
    });

    it(`maps ${code} at every write seam to io_error`, async () => {
      await withPaths(async (ctx) => {
        const seams: Array<{
          label: string;
          target: string;
          failWhen: (method: "realpath" | "stat" | "lstat", filePath: string) => boolean;
        }> = [
          {
            label: "parent realpath",
            target: "Proyectos/New.md",
            failWhen: (m, f) => m === "realpath" && f === ctx.vault.absolute("Proyectos"),
          },
          {
            label: "parent stat",
            target: "Proyectos/New.md",
            failWhen: (m, f) => m === "stat" && f === ctx.vault.absolute("Proyectos"),
          },
          {
            label: "target lstat",
            target: "CLAUDE.md",
            failWhen: (m, f) => m === "lstat" && f === ctx.vault.absolute("CLAUDE.md"),
          },
          {
            label: "target realpath",
            target: "CLAUDE.md",
            failWhen: (m, f) => m === "realpath" && f === ctx.vault.absolute("CLAUDE.md"),
          },
        ];
        for (const seam of seams) {
          const fs = failingPathsFs(seam.failWhen, code);
          const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs });
          const err = await capture(() => paths.resolveWrite(seam.target));
          expect(err, `${code}:${seam.label}`).toBeDefined();
          expect(err?.code, `${code}:${seam.label}`).toBe("io_error");
          expect(err?.message, `${code}:${seam.label}`).not.toContain(ctx.vault.vaultPath);
        }
      });
    });
  }

  it("never leaks raw filesystem paths in io_error serialization", async () => {
    await withPaths(async (ctx) => {
      const fs = failingPathsFs(
        (method, filePath) => method === "lstat" && filePath === ctx.vault.absolute("CLAUDE.md"),
        "EACCES",
      );
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs });
      const err = await capture(() => paths.resolveRead("CLAUDE.md"));
      expect(err).toBeDefined();
      expect(JSON.stringify(err)).not.toContain(ctx.vault.vaultPath);
      expect(JSON.stringify(err)).not.toContain("CLAUDE.md");
      expect(JSON.stringify(err)).not.toContain("EACCES");
    });
  });
});

describe("VaultPaths: non-regular write targets", () => {
  it("rejects a FIFO/socket-shaped write target with target_not_file before realpath", async () => {
    await withPaths(async (ctx) => {
      const targetAbs = ctx.vault.absolute("Proyectos/pipe.md");
      const { fs, realpathCalls } = nonRegularTargetFs(targetAbs);
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs });
      const err = await capture(() => paths.resolveWrite("Proyectos/pipe.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_not_file");
      expect(realpathCalls).not.toContain(targetAbs);
      expect(realpathCalls).not.toContain(ctx.vault.absolute("Proyectos/pipe.md"));
    });
  });

  it("rejects an existing FIFO write target with target_not_file", async () => {
    await withPaths(async (ctx) => {
      const fifoAbs = ctx.vault.absolute("pipe.md");
      try {
        execFileSync("mkfifo", [fifoAbs]);
      } catch {
        return; // mkfifo unavailable: the injected-seam test above covers the rule.
      }
      const err = await capture(() => ctx.paths.resolveWrite("pipe.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("target_not_file");
      const readErr = await capture(() => ctx.paths.resolveRead("pipe.md"));
      expect(readErr).toBeDefined();
      expect(readErr?.code).toBe("target_not_file");
    });
  });

  it("still accepts a write to an existing regular file", async () => {
    await withPaths(async (ctx) => {
      const resolved = await ctx.paths.resolveWrite("CLAUDE.md");
      expect(resolved.absolute).toBe(ctx.vault.paths.claudeMd);
    });
  });
});

describe("VaultPaths: pinned vault root identity", () => {
  it("rejects a root-level new write after the vault root symlink is retargeted outside", async () => {
    await withPaths(async (ctx) => {
      const link = path.join(ctx.root, "vault-link");
      await symlink(ctx.vault.vaultPath, link);
      const paths = new VaultPaths(link, { identity: ctx.identity, fs: nodeVaultPathsFs });
      // First call pins the initial identity through the link.
      const first = await paths.resolveRead("CLAUDE.md");
      expect(first.absolute).toBe(path.join(link, "CLAUDE.md"));
      // Retarget the symlink to a directory outside the pinned vault.
      await rm(link);
      await symlink(ctx.outsideDir, link);
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
      expect(err?.message).not.toContain(ctx.vault.vaultPath);
      expect(err?.message).not.toContain("outside");
      expect(JSON.stringify(err)).not.toContain(ctx.vault.vaultPath);
    });
  });

  it("rejects reads after the vault root symlink is retargeted outside", async () => {
    await withPaths(async (ctx) => {
      const link = path.join(ctx.root, "vault-link");
      await symlink(ctx.vault.vaultPath, link);
      const paths = new VaultPaths(link, { identity: ctx.identity, fs: nodeVaultPathsFs });
      await paths.resolveRead("CLAUDE.md");
      await rm(link);
      await symlink(ctx.outsideDir, link);
      const err = await capture(() => paths.resolveRead("CLAUDE.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a root-level write after the vault root is renamed away", async () => {
    await withPaths(async (ctx) => {
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs: nodeVaultPathsFs });
      await paths.resolveWrite("note.md");
      const moved = path.join(ctx.root, "vault-moved");
      await rename(ctx.vault.vaultPath, moved);
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("io_error");
      const readErr = await capture(() => paths.resolveRead("CLAUDE.md"));
      expect(readErr).toBeDefined();
      expect(readErr?.code).toBe("io_error");
    });
  });

  it("rejects a root-level write after the vault root is replaced by an outside symlink", async () => {
    await withPaths(async (ctx) => {
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs: nodeVaultPathsFs });
      await paths.resolveWrite("note.md");
      await rm(ctx.vault.vaultPath, { recursive: true, force: true });
      await symlink(ctx.outsideDir, ctx.vault.vaultPath);
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a root-level write after the vault root directory is replaced at the same pathname", async () => {
    await withPaths(async (ctx) => {
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs: nodeVaultPathsFs });
      await paths.resolveWrite("note.md");
      // Renaming the vault away and recreating a brand-new directory at the
      // same pathname keeps the same realpath string. The old inode stays
      // live at the moved path, so the replacement must have a different
      // dev/ino identity; only identity pinning can detect this.
      const moved = path.join(ctx.root, "vault-moved");
      await rename(ctx.vault.vaultPath, moved);
      await mkdir(ctx.vault.vaultPath);
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
      const readErr = await capture(() => paths.resolveRead("CLAUDE.md"));
      expect(readErr).toBeDefined();
      expect(readErr?.code).toBe("symlink_escape");
    });
  });

  it("still accepts root-level new writes while the root is unchanged", async () => {
    await withPaths(async (ctx) => {
      const first = await ctx.paths.resolveWrite("BrandNew.md");
      expect(first.absolute).toBe(ctx.vault.absolute("BrandNew.md"));
      const second = await ctx.paths.resolveWrite("BrandNew2.md");
      expect(second.absolute).toBe(ctx.vault.absolute("BrandNew2.md"));
      const read = await ctx.paths.resolveRead("CLAUDE.md");
      expect(read.vaultRelative).toBe("CLAUDE.md");
    });
  });

  it("keeps rejecting nested writes after the root is retargeted outside", async () => {
    await withPaths(async (ctx) => {
      const link = path.join(ctx.root, "vault-link");
      await symlink(ctx.vault.vaultPath, link);
      const paths = new VaultPaths(link, { identity: ctx.identity, fs: nodeVaultPathsFs });
      await paths.resolveRead("CLAUDE.md");
      await rm(link);
      await symlink(ctx.outsideDir, link);
      const err = await capture(() => paths.resolveWrite("Proyectos/New.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });
});

describe("VaultPaths: config-trusted root identity (no trust-on-first-use)", () => {
  it("rejects a root replaced at the same pathname before the first resolve", async () => {
    await withPaths(async (ctx) => {
      // The original vault is moved away and a brand-new directory appears at
      // the same pathname before any resolve. Only a config-validated pinned
      // identity can reject this; trust-on-first-use would bless the
      // replacement as the new root.
      const moved = path.join(ctx.root, "vault-moved");
      await rename(ctx.vault.vaultPath, moved);
      await mkdir(ctx.vault.vaultPath);
      const paths = new VaultPaths(ctx.vault.vaultPath, { identity: ctx.identity, fs: nodeVaultPathsFs });
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
      const readErr = await capture(() => paths.resolveRead("CLAUDE.md"));
      expect(readErr).toBeDefined();
      expect(readErr?.code).toBe("symlink_escape");
    });
  });

  it("rejects a symlink root retargeted outside before the first resolve", async () => {
    await withPaths(async (ctx) => {
      const link = path.join(ctx.root, "vault-link");
      await symlink(ctx.vault.vaultPath, link);
      // Retarget the link to an outside directory before any resolve.
      await rm(link);
      await symlink(ctx.outsideDir, link);
      const paths = new VaultPaths(link, { identity: ctx.identity, fs: nodeVaultPathsFs });
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });

  it("rejects a symlink root replaced by a real directory before the first resolve", async () => {
    await withPaths(async (ctx) => {
      const link = path.join(ctx.root, "vault-link");
      await symlink(ctx.vault.vaultPath, link);
      // Replace the link with an unrelated real directory before any resolve.
      await rm(link);
      await mkdir(link);
      const paths = new VaultPaths(link, { identity: ctx.identity, fs: nodeVaultPathsFs });
      const err = await capture(() => paths.resolveWrite("note.md"));
      expect(err).toBeDefined();
      expect(err?.code).toBe("symlink_escape");
    });
  });
});
