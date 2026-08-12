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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  nodeVaultPathsFs,
  VaultPathError,
  VaultPaths,
  type ResolvedVaultPath,
} from "../../src/paths.js";
import type { VaultPath } from "../../src/types.js";
import { createVault, type CreatedVault } from "../fixtures/create-vault.js";

interface PathsContext {
  root: string;
  vault: CreatedVault;
  paths: VaultPaths;
  /** Absolute path of a file outside the vault, for escape fixtures. */
  outsideFile: string;
  /** Absolute path of a directory outside the vault, for escape fixtures. */
  outsideDir: string;
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
    const paths = new VaultPaths(vault.vaultPath, {
      attachmentsDir: vault.layout.attachmentsDir,
      fs: nodeVaultPathsFs,
    });
    return await body({ root, vault, paths, outsideFile, outsideDir });
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
