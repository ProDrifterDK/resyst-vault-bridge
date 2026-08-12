import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/config.js";
import {
  buildAssociationProposal,
  makeGitRunner,
  normalizeRemote,
  parseRemoteV,
  MAX_LEXICAL_CANDIDATES,
  nodeProjectFs,
  resolveProject,
  resolveProjectWithCandidates,
  type GitRunner,
  type ProjectExecFile,
  type ProjectDirent,
  type ProjectFs,
} from "../../src/project.js";
import type { HostId, IsoTimestamp, ProjectId, VaultPath } from "../../src/types.js";

interface MemoryFile {
  path: string;
  source: string;
}

function dirent(name: string, directory: boolean): ProjectDirent {
  return {
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  };
}

function memoryFs(files: MemoryFile[], cwdPaths: string[] = []): ProjectFs {
  const fileMap = new Map(files.map((file) => [file.path, file.source]));
  const dirs = new Set<string>(["/vault", "/vault/Proyectos", ...cwdPaths]);
  for (const file of files) {
    let parent = file.path.slice(0, file.path.lastIndexOf("/"));
    while (parent.length > 0) {
      dirs.add(parent);
      const next = parent.slice(0, parent.lastIndexOf("/"));
      if (next === parent) break;
      parent = next;
    }
  }
  return {
    async readFileBounded(filePath, maxBytes) {
      const source = fileMap.get(filePath);
      if (source === undefined) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (Buffer.byteLength(source, "utf8") > maxBytes) {
        throw new Error("bounded read overflow");
      }
      return source;
    },
    async readdir(filePath) {
      const names = new Map<string, boolean>();
      const prefix = `${filePath}/`;
      for (const directory of dirs) {
        if (!directory.startsWith(prefix)) continue;
        const rest = directory.slice(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) names.set(rest, true);
      }
      for (const file of files) {
        if (!file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) names.set(rest, false);
      }
      return [...names.entries()].map(([name, isDirectory]) =>
        dirent(name, isDirectory),
      );
    },
    async stat(filePath) {
      if (!dirs.has(filePath) && !fileMap.has(filePath)) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return defaultSyntheticStat(filePath);
    },
    async lstat(filePath) {
      if (!dirs.has(filePath) && !fileMap.has(filePath)) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return defaultSyntheticStat(filePath);
    },
    async realpath(filePath) {
      if (dirs.has(filePath) || fileMap.has(filePath)) return filePath;
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  };
}

function config(overrides: BridgeConfig["project_overrides"] = []): BridgeConfig {
  return {
    version: 1,
    host_id: "casey" as HostId,
    vault_path: "/vault",
    vault_identity: { real_path: "/vault", dev: 1n, ino: 2n },
    layout: {
      daily_dir: "Notas Diarias",
      projects_dir: "Proyectos",
      inbox_dir: "Inbox",
      templates_dir: "_plantillas",
      attachments_dir: "_adjuntos",
    },
    templates: { daily: null },
    managed_headings: {
      tareas: "## Tareas",
      reflexion: "## Reflexión",
      notas: "## Notas",
      enlaces: "## Enlaces del día",
    },
    budget: { context_tokens: 5000 },
    conventions: { project_frontmatter_field: "resyst_project" },
    project_overrides: overrides,
  };
}

const git: GitRunner = async () => ({
  ok: true,
  stdout: "origin\thttps://github.com/tester/atlas.git (fetch)\n",
  stderr: "",
});

const atlasNote = `---\ntitle: Atlas\nresyst_project:\n  id: atlas\n  repos:\n    - github.com/tester/atlas\n  aliases:\n    - Atlas Project\n---\n# Atlas\n`;

// Keep the regression fixtures independent of implementation internals while
// documenting the modest scanner budgets expected at the public seam.
const TEST_MAX_NOTE_BYTES = 512 * 1024;
const TEST_MAX_SCAN_ENTRIES = 4096;
const TEST_MAX_SCAN_DIRECTORIES = 512;
const TEST_MAX_SCAN_ENTRIES_PER_DIRECTORY = 256;
const TEST_MAX_SCAN_DEPTH = 16;

interface SyntheticStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
}

function syntheticStat(
  filePath: string,
  kind: "directory" | "file" | "other" | "symlink" = "file",
  dev: bigint = 1n,
  ino: bigint = 3n,
): SyntheticStat {
  void filePath;
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file" || kind === "symlink",
    isSymbolicLink: () => kind === "symlink",
    dev,
    ino,
  };
}

function defaultSyntheticStat(filePath: string): SyntheticStat {
  if (filePath === "/vault") return syntheticStat(filePath, "directory", 1n, 2n);
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  return syntheticStat(filePath, /\.[^/]+$/.test(name) ? "file" : "directory");
}

function boundaryFs(
  base: ProjectFs,
  options: {
    stat?: (filePath: string) => SyntheticStat;
    lstat?: (filePath: string) => SyntheticStat;
    realpath?: (filePath: string) => Promise<string>;
  } = {},
): ProjectFs {
  return {
    ...base,
    stat: async (filePath: string) =>
      options.stat?.(filePath) ?? defaultSyntheticStat(filePath),
    lstat: async (filePath: string) =>
      options.lstat?.(filePath) ?? options.stat?.(filePath) ?? defaultSyntheticStat(filePath),
    realpath: options.realpath ?? base.realpath,
  };
}

describe("normalizeRemote", () => {
  it.each([
    [
      "https://casey:secret@github.com/tester/atlas.git?x=1#fragment",
      "github.com/tester/atlas",
    ],
    ["git@github.com:tester/atlas.git", "github.com/tester/atlas"],
    ["ssh://git@github.com/tester/atlas.git", "github.com/tester/atlas"],
  ])("normalizes %s without credentials or suffixes", (input, expected) => {
    expect(normalizeRemote(input)?.repo).toBe(expected);
  });
});

describe("resolveProject", () => {
  it("resolves a synthetic Atlas note through the public seam", async () => {
    const fs = memoryFs([{ path: "/vault/Proyectos/Atlas.md", source: atlasNote }], [
      "/workspace/atlas",
    ]);
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git,
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "remote",
      note_path: "Proyectos/Atlas.md",
    });
  });

  it("returns lexical candidates without selecting one", async () => {
    const fs = memoryFs(
      [
        { path: "/vault/Proyectos/Project Atlas.md", source: "# Project\n" },
        { path: "/vault/Proyectos/Archive Atlas.md", source: "# Archive\n" },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "no_match" });
    expect(outcome.lexical_candidates.map((candidate) => candidate.path)).toEqual([
      "Proyectos/Archive Atlas.md",
      "Proyectos/Project Atlas.md",
    ]);
  });
});


describe("remote parsing and shell-free Git seam", () => {
  it("dedupes fetch/push remotes and sorts different remotes", () => {
    const remotes = parseRemoteV(
      [
        "upstream\thttps://github.com/upstream/atlas.git (fetch)",
        "origin\tgit@github.com:tester/atlas.git (fetch)",
        "origin\tgit@github.com:tester/atlas.git (push)",
        "bad\t/home/casey/atlas (fetch)",
      ].join("\n"),
    );
    expect(remotes.map((remote) => remote.repo)).toEqual([
      "github.com/tester/atlas",
      "github.com/upstream/atlas",
    ]);
  });

  it("injects git -C argv, bounded output, timeout, and shell=false", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const execFile: ProjectExecFile = async (file, args, options) => {
      calls.push({ file, args, options: { ...options } });
      return { stdout: "", stderr: "" };
    };
    const git = makeGitRunner(execFile);
    const result = await git(["remote", "-v"], { cwd: "/workspace/atlas" });
    expect(result).toEqual({ ok: true, stdout: "", stderr: "" });
    expect(calls).toEqual([
      {
        file: "git",
        args: ["-C", "/workspace/atlas", "remote", "-v"],
        options: {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: 5_000,
          killSignal: "SIGTERM",
          shell: false,
          windowsHide: true,
        },
      },
    ]);
  });

  it("redacts injected Git failures instead of exposing stderr", async () => {
    const git = makeGitRunner(async () => {
      throw new Error("secret-token /home/casey/private");
    });
    expect(await git(["remote", "-v"], { cwd: "/workspace/atlas" })).toEqual({
      ok: false,
    });
  });

  it("uses the injected execFile through resolveProject without running real Git", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fs = memoryFs([], ["/workspace/atlas"]);
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "no_match" });
    expect(calls).toEqual([
      { file: "git", args: ["-C", "/workspace/atlas", "remote", "-v"] },
    ]);
  });
});

describe("resolution precedence and exact matching", () => {
  it("prefers portable id over an exact legacy filename", async () => {
    const fs = memoryFs(
      [
        {
          path: "/vault/Proyectos/Portable.md",
          source: `---\nresyst_project:\n  id: atlas\n---\n# Portable\n`,
        },
        { path: "/vault/Proyectos/atlas.md", source: "# atlas\n" },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Portable.md",
    });
  });

  it("resolves a portable alias with normalized case, spaces, and Unicode", async () => {
    const fs = memoryFs(
      [
        {
          path: "/vault/Proyectos/Cafe.md",
          source: `---\nresyst_project:\n  id: cafe\n  aliases:\n    - cafe\u0301 project\n---\n# Cafe\n`,
        },
      ],
      ["/workspace/Café Project"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/Café Project",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "cafe",
      basis: "alias",
      note_path: "Proyectos/Cafe.md",
    });
  });

  it("uses exact local overrides only, never a path prefix", async () => {
    const fs = memoryFs([], ["/workspace/atlas", "/workspace/atlas-child"]);
    const exact = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config([{ path: "/workspace/atlas", project_id: "atlas" as ProjectId }]),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(exact.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "local_override",
      note_path: null,
    });
    const prefix = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas-child",
      config: config([{ path: "/workspace/atlas", project_id: "atlas" as ProjectId }]),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(prefix.resolution.kind).toBe("unresolved");
  });

  it("matches exact directory, title, and legacy alias only after higher tiers", async () => {
    const fs = memoryFs(
      [
        { path: "/vault/Proyectos/Atlas/Status.md", source: "# Status\n" },
        { path: "/vault/Proyectos/Report.md", source: "---\ntitle: Atlas\n---\n# Report\n" },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution.kind).toBe("ambiguous");
    if (outcome.resolution.kind === "ambiguous") {
      expect(outcome.resolution.candidates).toEqual([
        "Proyectos/Atlas/Status.md",
        "Proyectos/Report.md",
      ]);
    }
  });
});

describe("unresolved, ambiguity, bounds, and association proposals", () => {
  it("distinguishes no-Git from available Git with no matching note", async () => {
    const fs = memoryFs(
      [{ path: "/vault/Proyectos/Other.md", source: "# Other\n" }],
      ["/workspace/atlas"],
    );
    const noGit = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: false }),
    });
    expect(noGit.resolution).toEqual({ kind: "unresolved", reason: "no_git" });
    const noMatch = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(noMatch.resolution).toEqual({ kind: "unresolved", reason: "no_match" });
  });

  it("returns duplicate equal candidates as a stable ambiguous union", async () => {
    const fs = memoryFs(
      [
        { path: "/vault/Proyectos/Atlas/One.md", source: "# Atlas\n" },
        { path: "/vault/Proyectos/Archive/Atlas.md", source: "# Atlas\n" },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "ambiguous",
      candidates: ["Proyectos/Archive/Atlas.md", "Proyectos/Atlas/One.md"],
    });
    const proposal = buildAssociationProposal(
      outcome,
      "2026-08-11T12:00:00.000Z" as IsoTimestamp,
    );
    expect(proposal).toEqual({
      version: 1,
      kind: "association",
      resolution: outcome.resolution,
      candidates: ["Proyectos/Archive/Atlas.md", "Proyectos/Atlas/One.md"],
      daily_write_only: true,
      created_at: "2026-08-11T12:00:00.000Z",
    });
    expect(JSON.stringify(proposal)).not.toContain("/vault/");
  });

  it("marks unreadable project notes as fixed unresolved data", async () => {
    const base = memoryFs(
      [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
      ["/workspace/atlas"],
    );
    const fs: ProjectFs = {
      ...base,
      readFileBounded: async () => {
        const error = new Error("secret /vault/Atlas") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    };
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome).toEqual({
      resolution: { kind: "unresolved", reason: "unreadable" },
      lexical_candidates: [],
    });
  });

  it("bounds lexical candidates and never selects the first lexical match", async () => {
    const files = Array.from({ length: MAX_LEXICAL_CANDIDATES + 3 }, (_, index) => ({
      path: `/vault/Proyectos/Archive Atlas ${index}.md`,
      source: `# Archive ${index}\n`,
    }));
    const fs = memoryFs(files, ["/workspace/atlas"]);
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution.kind).toBe("unresolved");
    expect(outcome.lexical_candidates).toHaveLength(MAX_LEXICAL_CANDIDATES);
    expect(outcome.lexical_candidates.every((candidate) => candidate.path.startsWith("Proyectos/"))).toBe(true);
  });

  it("returns no proposal for a resolved project", async () => {
    const fs = memoryFs([{ path: "/vault/Proyectos/Atlas.md", source: atlasNote }], [
      "/workspace/atlas",
    ]);
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git,
    });
    expect(buildAssociationProposal(outcome, "2026-08-11T12:00:00.000Z" as IsoTimestamp)).toBeNull();
  });

  it("redacts absolute candidate paths even when proposal input is malformed", () => {
    const proposal = buildAssociationProposal(
      { kind: "ambiguous", candidates: ["/secret/vault/Atlas.md" as VaultPath] },
      "2026-08-11T12:00:00.000Z" as IsoTimestamp,
    );
    expect(proposal).toBeNull();
  });
});


describe("association proposal runtime boundary", () => {
  const timestamp = "2026-08-11T12:00:00.000Z" as IsoTimestamp;

  it("rejects a malicious unresolved reason instead of copying it", () => {
    const input = {
      kind: "unresolved",
      reason: { toString: () => "attacker" },
    } as unknown as Parameters<typeof buildAssociationProposal>[0];
    expect(buildAssociationProposal(input, timestamp)).toBeNull();
  });

  it("rejects a malformed or non-UTC timestamp", () => {
    const resolution = { kind: "unresolved", reason: "no_match" } as const;
    expect(
      buildAssociationProposal(
        resolution,
        "2026-08-11T12:00:00+01:00" as unknown as IsoTimestamp,
      ),
    ).toBeNull();
    expect(
      buildAssociationProposal(
        resolution,
        "not-a-timestamp" as unknown as IsoTimestamp,
      ),
    ).toBeNull();
  });

  it("rejects absolute, traversal, control, and underfilled ambiguous paths", () => {
    const malformedInputs = [
      ["Projects/Atlas.md", "/secret/Atlas.md"],
      ["Projects/Atlas.md", "../escape.md"],
      ["Projects/Atlas.md", "Projects/Bad\u0000.md"],
      ["Projects/Atlas.md", "Projects/Atlas.md"],
      ["Projects/Atlas.md", "Projects/Other.txt"],
      ["/secret/Atlas.md"],
    ];
    for (const candidates of malformedInputs) {
      const input = {
        kind: "ambiguous",
        candidates,
      } as unknown as Parameters<typeof buildAssociationProposal>[0];
      expect(buildAssociationProposal(input, timestamp)).toBeNull();
    }
  });

  it("rejects malformed unresolved candidate items instead of dropping them", () => {
    const wrapper = {
      resolution: { kind: "unresolved", reason: "no_match" },
      lexical_candidates: [{ path: "/secret/Atlas.md" }],
    } as unknown as Parameters<typeof buildAssociationProposal>[0];
    expect(buildAssociationProposal(wrapper, timestamp)).toBeNull();
    const extraWrapper = {
      resolution: { kind: "unresolved", reason: "no_match" },
      lexical_candidates: [],
      attacker: "copied?",
    } as unknown as Parameters<typeof buildAssociationProposal>[0];
    expect(buildAssociationProposal(extraWrapper, timestamp)).toBeNull();
    expect(
      buildAssociationProposal(
        { kind: "unresolved", reason: "no_match" },
        timestamp,
        ["../escape.md" as VaultPath],
      ),
    ).toBeNull();
    expect(
      buildAssociationProposal(
        { kind: "unresolved", reason: "no_match" },
        timestamp,
        "Projects/Atlas.md" as unknown as readonly VaultPath[],
      ),
    ).toBeNull();
  });

  it("rejects oversized direct candidate arrays before materialization", () => {
    const huge = Array.from(
      { length: MAX_LEXICAL_CANDIDATES + 1 },
      () => "Projects/Atlas.md" as VaultPath,
    );
    const unresolved = { kind: "unresolved", reason: "no_match" } as const;
    expect(
      buildAssociationProposal(
        unresolved,
        timestamp,
        huge as unknown as readonly VaultPath[],
      ),
    ).toBeNull();
    const ambiguous = {
      kind: "ambiguous",
      candidates: huge,
    } as unknown as Parameters<typeof buildAssociationProposal>[0];
    expect(buildAssociationProposal(ambiguous, timestamp)).toBeNull();
  });
});

describe("production bounded project adapter", () => {
  it("measures UTF-8 bytes and rejects max+1 without unbounded allocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-project-bounded-"));
    const filePath = path.join(root, "note.md");
    try {
      await writeFile(filePath, "éa", "utf8"); // 3 bytes, 2 JS characters.
      await expect(nodeProjectFs.readFileBounded(filePath, 3)).resolves.toBe("éa");
      await expect(nodeProjectFs.readFileBounded(filePath, 2)).rejects.toBeDefined();
      await expect(
        nodeProjectFs.readFileBounded(filePath, TEST_MAX_NOTE_BYTES + 1),
      ).rejects.toBeDefined();
      await writeFile(filePath, "abc", "utf8");
      await expect(nodeProjectFs.readFileBounded(filePath, 3)).resolves.toBe("abc");
      await writeFile(filePath, "abcd", "utf8");
      await expect(nodeProjectFs.readFileBounded(filePath, 3)).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scanner validation, bounded traversal, and exact fallback provenance", () => {
  it("fails closed when the config-trusted vault root identity is replaced", async () => {
    const base = memoryFs(
      [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
      ["/workspace/atlas"],
    );
    const fs = boundaryFs(base, {
      stat: (filePath) =>
        filePath === "/vault"
          ? syntheticStat(filePath, "directory", 9n, 10n)
          : defaultSyntheticStat(filePath),
    });
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome).toEqual({
      resolution: { kind: "unresolved", reason: "unreadable" },
      lexical_candidates: [],
    });
  });

  it("fails closed when a traversed normal directory resolves outside the vault", async () => {
    const base = memoryFs(
      [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
      ["/workspace/atlas"],
    );
    const fs = boundaryFs(base, {
      realpath: async (filePath) =>
        filePath === "/vault/Proyectos" ? "/outside/projects" : base.realpath(filePath),
    });
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("rejects an injected outside note immediately before reading it", async () => {
    const base = memoryFs([], ["/workspace/Injected"]);
    const fs = boundaryFs({
      ...base,
      async readdir(filePath) {
        if (filePath === "/vault/Proyectos") return [dirent("Injected.md", false)];
        return base.readdir(filePath);
      },
      async readFileBounded(filePath, maxBytes) {
        if (filePath === "/vault/Proyectos/Injected.md") return "# Injected\n";
        return base.readFileBounded(filePath, maxBytes);
      },
    }, {
      realpath: async (filePath) => {
        if (filePath === "/vault/Proyectos/Injected.md") return "/outside/Injected.md";
        return base.realpath(filePath);
      },
    });
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/Injected",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("rejects a note target that is a symlink or non-regular file", async () => {
    for (const kind of ["symlink", "other"] as const) {
      const base = memoryFs(
        [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
        ["/workspace/atlas"],
      );
      const fs = boundaryFs(base, {
        lstat: (filePath) =>
          filePath === "/vault/Proyectos/Atlas.md"
            ? syntheticStat(filePath, kind)
            : defaultSyntheticStat(filePath),
        stat: (filePath) =>
          filePath === "/vault/Proyectos/Atlas.md"
            ? syntheticStat(filePath, kind)
            : defaultSyntheticStat(filePath),
        realpath: async (filePath) =>
          filePath === "/vault/Proyectos/Atlas.md" && kind === "symlink"
            ? "/outside/Atlas.md"
            : base.realpath(filePath),
      });
      const outcome = await resolveProjectWithCandidates({
        cwd: "/workspace/atlas",
        config: config(),
        fs,
        git: async () => ({ ok: true, stdout: "", stderr: "" }),
      });
      expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
    }
  });

  it("invalidates the complete scan on malformed delimited frontmatter", async () => {
    const fs = boundaryFs(
      memoryFs(
        [
          { path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" },
          { path: "/vault/Proyectos/Zed.md", source: "---\ntitle: [\n---\n# Zed\n" },
        ],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome).toEqual({
      resolution: { kind: "unresolved", reason: "unreadable" },
      lexical_candidates: [],
    });
  });

  it("uses the bounded max+1 note-read seam and rejects overflow", async () => {
    const base = memoryFs(
      [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
      ["/workspace/atlas"],
    );
    let boundedCalls = 0;
    const fs = boundaryFs({
      ...base,
      readFileBounded: async (_filePath, maxBytes) => {
        boundedCalls += 1;
        expect(maxBytes).toBe(TEST_MAX_NOTE_BYTES);
        throw new Error("bounded max+1 overflow");
      },
    });
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome).toEqual({
      resolution: { kind: "unresolved", reason: "unreadable" },
      lexical_candidates: [],
    });
    expect(boundedCalls).toBe(1);
  });

  it("invalidates the complete scan on an oversized note after a valid note", async () => {
    const fs = boundaryFs(
      memoryFs(
        [
          { path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" },
          { path: "/vault/Proyectos/Zed.md", source: "x".repeat(TEST_MAX_NOTE_BYTES + 1) },
        ],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("fails closed on conflicting exact canonical overrides", async () => {
    const fs = boundaryFs(memoryFs([], ["/workspace/atlas"]));
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config([
        { path: "/workspace/atlas", project_id: "atlas" as ProjectId },
        { path: "/workspace/atlas", project_id: "other" as ProjectId },
      ]),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
    expect(outcome.resolution.kind).not.toBe("ambiguous");
  });

  it("rejects a very wide directory before scanning its materialized entries", async () => {
    const files = Array.from(
      { length: TEST_MAX_SCAN_ENTRIES_PER_DIRECTORY + 1 },
      (_, index) => ({
        path: `/vault/Proyectos/entry-${index}.txt`,
        source: "ignored",
      }),
    );
    const fs = boundaryFs(memoryFs(files, ["/workspace/atlas"]));
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("rejects total traversal work even when each directory is individually narrow", async () => {
    const files: MemoryFile[] = [];
    for (let directory = 0; directory < 20; directory += 1) {
      for (let entry = 0; entry < TEST_MAX_SCAN_ENTRIES_PER_DIRECTORY; entry += 1) {
        files.push({
          path: `/vault/Proyectos/d${directory}/entry-${entry}.txt`,
          source: "ignored",
        });
      }
    }
    expect(files.length).toBeGreaterThan(TEST_MAX_SCAN_ENTRIES);
    const fs = boundaryFs(memoryFs(files, ["/workspace/atlas"]));
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("rejects total directory work independently of note and entry counts", async () => {
    const files: MemoryFile[] = [];
    for (let branch = 0; branch < 16; branch += 1) {
      for (let leaf = 0; leaf < 32; leaf += 1) {
        files.push({
          path: `/vault/Proyectos/r${branch}/d${leaf}/ignore.txt`,
          source: "ignored",
        });
      }
    }
    expect(16 + 16 * 32).toBeGreaterThan(TEST_MAX_SCAN_DIRECTORIES);
    const fs = boundaryFs(memoryFs(files, ["/workspace/atlas"]));
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("rejects a deep tree instead of selecting a note from a partial scan", async () => {
    const deep = Array.from({ length: TEST_MAX_SCAN_DEPTH + 2 }, (_, index) => `d${index}`).join("/");
    const fs = boundaryFs(
      memoryFs(
        [
          { path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" },
          { path: `/vault/Proyectos/${deep}/Zed.txt`, source: "ignored" },
        ],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("derives a legacy exact title match from the matched value, not the filename", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{ path: "/vault/Proyectos/Report.md", source: "---\ntitle: Atlas\n---\n# Report\n" }],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "Atlas",
      basis: "exact_name",
      note_path: "Proyectos/Report.md",
    });
  });

  it("derives a legacy exact nested-directory match from the matched parent", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{ path: "/vault/Proyectos/Atlas/Status.md", source: "# Status\n" }],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "Atlas",
      basis: "exact_name",
      note_path: "Proyectos/Atlas/Status.md",
    });
  });

  it("derives a normalized legacy exact alias from the alias value", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{ path: "/vault/Proyectos/Report.md", source: "---\naliases: [Atlas Project]\n---\n# Report\n" }],
        ["/workspace/Atlas Project"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/Atlas Project",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "Atlas-Project",
      basis: "exact_name",
      note_path: "Proyectos/Report.md",
    });
  });

  it("fails closed when one note has conflicting exact title and heading ids", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{
          path: "/vault/Proyectos/Report.md",
          source: "---\ntitle: Atlas\n---\n# atlas\n",
        }],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("does not let a safe note mask conflicting exact ids in another note", async () => {
    const fs = boundaryFs(
      memoryFs(
        [
          {
            path: "/vault/Proyectos/Conflict.md",
            source: "---\ntitle: Atlas\n---\n# atlas\n",
          },
          {
            path: "/vault/Proyectos/Safe.md",
            source: "---\ntitle: Atlas\n---\n# Safe\n",
          },
        ],
        ["/workspace/atlas"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });

  it("prefers a portable id over an unsafe exact legacy value", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{
          path: "/vault/Proyectos/Report.md",
          source: "---\nresyst_project:\n  id: atlas\ntitle: 🔥\n---\n# Report\n",
        }],
        ["/workspace/🔥"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/🔥",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "exact_name",
      note_path: "Proyectos/Report.md",
    });
  });

  it("fails closed when the exact legacy matched value cannot become a safe id", async () => {
    const fs = boundaryFs(
      memoryFs(
        [{ path: "/vault/Proyectos/Report.md", source: "---\naliases: [!!!]\n---\n# Report\n" }],
        ["/workspace/!!!"],
      ),
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/!!!",
      config: config(),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({ kind: "unresolved", reason: "unreadable" });
  });
});

describe("exact public ProjectResolution seam", () => {
  it("returns the discriminated union directly", async () => {
    const fs = memoryFs([{ path: "/vault/Proyectos/Atlas.md", source: atlasNote }], [
      "/workspace/atlas",
    ]);
    const resolution = await resolveProject({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git,
    });
    expect(resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "remote",
      note_path: "Proyectos/Atlas.md",
    });
  });
});


describe("strict tier precedence", () => {
  it("orders a matching remote above a portable id match", async () => {
    const fs = memoryFs(
      [
        {
          path: "/vault/Proyectos/Remote.md",
          source: `---\nresyst_project:\n  id: remote\n  repos:\n    - github.com/tester/atlas\n---\n# Remote\n`,
        },
        {
          path: "/vault/Proyectos/Id.md",
          source: `---\nresyst_project:\n  id: atlas\n---\n# Id\n`,
        },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config(),
      fs,
      git,
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "remote",
      basis: "remote",
      note_path: "Proyectos/Remote.md",
    });
  });

  it("orders portable id above a matching local override", async () => {
    const fs = memoryFs(
      [
        {
          path: "/vault/Proyectos/Id.md",
          source: `---\nresyst_project:\n  id: atlas\n---\n# Id\n`,
        },
      ],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config([{ path: "/workspace/atlas", project_id: "override" as ProjectId }]),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Id.md",
    });
  });

  it("orders an exact local override above an exact legacy name", async () => {
    const fs = memoryFs(
      [{ path: "/vault/Proyectos/Atlas.md", source: "# Atlas\n" }],
      ["/workspace/atlas"],
    );
    const outcome = await resolveProjectWithCandidates({
      cwd: "/workspace/atlas",
      config: config([{ path: "/workspace/atlas", project_id: "atlas" as ProjectId }]),
      fs,
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(outcome.resolution).toEqual({
      kind: "resolved",
      project_id: "atlas",
      basis: "local_override",
      note_path: "Proyectos/Atlas.md",
    });
  });
});
