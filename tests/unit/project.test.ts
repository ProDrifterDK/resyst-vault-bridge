import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/config.js";
import {
  buildAssociationProposal,
  makeGitRunner,
  normalizeRemote,
  parseRemoteV,
  MAX_LEXICAL_CANDIDATES,
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
    async readFile(filePath) {
      const source = fileMap.get(filePath);
      if (source === undefined) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
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
      readFile: async () => {
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
    expect(proposal).toEqual({
      version: 1,
      kind: "association",
      resolution: { kind: "ambiguous", candidates: [] },
      candidates: [],
      daily_write_only: true,
      created_at: "2026-08-11T12:00:00.000Z",
    });
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
