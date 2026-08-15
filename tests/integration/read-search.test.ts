import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/config.js";
import { readVaultNote } from "../../src/search.js";
import type { HostId } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const temporaryDirectories: string[] = [];

async function fixtureConfig(root: string): Promise<BridgeConfig> {
  const rootStat = await stat(root, { bigint: true });
  return {
    version: 1,
    host_id: "casey" as HostId,
    vault_path: root,
    vault_identity: {
      real_path: await realpath(root),
      dev: rootStat.dev,
      ino: rootStat.ino,
    },
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
    budget: { context_tokens: 5_000 },
    conventions: { project_frontmatter_field: "resyst_project" },
    project_overrides: [],
    pi_root_authority: false,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("readVaultNote", () => {
  it("reads a full note or one exact section with provenance and quoted content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-read-integration-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote(
      "Proyectos/Atlas.md",
      "# Atlas\n\n## Estado\nCurrent state.\n\n### Detail\nNested detail.\n\n## Next\nLater.\n",
    );
    const config = await fixtureConfig(root);

    const full = await readVaultNote({ config, path: "Proyectos/Atlas.md" });
    const section = await readVaultNote({
      config,
      path: "Proyectos/Atlas.md",
      heading: "## Estado",
    });

    expect(full.path).toBe("Proyectos/Atlas.md");
    expect(full.heading).toBeNull();
    expect(full.content).toContain("> # Atlas");
    expect(full.content).toContain("> Later.");
    expect(section.heading).toBe("## Estado");
    expect(section.content).toContain("> Current state.");
    expect(section.content).toContain("> ### Detail");
    expect(section.content).not.toContain("> ## Next");
    expect(section.content).not.toContain("> Later.");
    expect(section.content).toContain("[BEGIN UNTRUSTED USER KNOWLEDGE");
    expect(section.content).toContain("[END UNTRUSTED USER KNOWLEDGE]");
    expect(section.modified_at).toMatch(/^\d{4}-/u);
    expect(JSON.stringify({ full, section })).not.toContain(root);
  });

  it("fails closed for missing, duplicate, and invalid exact headings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-read-errors-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote("Duplicate.md", "# Note\n## Same\nOne\n## Same\nTwo\n");
    const config = await fixtureConfig(root);

    await expect(readVaultNote({ config, path: "Duplicate.md", heading: "## Missing" }))
      .rejects.toMatchObject({ name: "VaultReadError", code: "heading_missing" });
    await expect(readVaultNote({ config, path: "Duplicate.md", heading: "## Same" }))
      .rejects.toMatchObject({ code: "heading_ambiguous", count: 2 });
    await expect(readVaultNote({ config, path: "Duplicate.md", heading: "Same" }))
      .rejects.toMatchObject({ code: "invalid_heading" });
  });

  it("rebuilds stale search cache and never exposes the temporary vault path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-search-integration-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote("Proyectos/Atlas.md", "---\ntitle: Atlas\naliases: [North Star]\n---\n# Atlas\nfirst launch state\n");
    const config = await fixtureConfig(root);
    let cached: unknown = null;
    const cache = {
      async read(): Promise<unknown> { return cached; },
      async write(serialized: string): Promise<void> { cached = serialized; },
    };
    const { searchVault } = await import("../../src/search.js");

    const first = await searchVault({ config, query: "first launch", cache });
    expect(first.cache).toBe("rebuilt");
    await vault.writeNote("Proyectos/Atlas.md", "---\ntitle: Atlas\naliases: [North Star]\n---\n# Atlas\nsecond changed launch state\n");
    const second = await searchVault({ config, query: "second changed", cache });

    expect(second.cache).toBe("rebuilt");
    expect(second.hits[0]?.path).toBe("Proyectos/Atlas.md");
    expect(second.hits[0]?.matched_on).toContain("content");
    expect(JSON.stringify({ first, second })).not.toContain(root);
  });

  it("bounds full-note reads independently from search snippets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-read-limit-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote("Long.md", `# Long\n${"😀".repeat(80_000)}\n`);
    const config = await fixtureConfig(root);

    const result = await readVaultNote({ config, path: "Long.md" });

    expect(result.content.length).toBeGreaterThan(8_000);
    expect(result.content.length).toBeLessThanOrEqual(100_000);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[END UNTRUSTED USER KNOWLEDGE]");
    expect(result.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(result.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("keeps the direct-read ceiling below the search indexing ceiling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-split-limit-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote("Large.md", `# Large
searchable split needle
${"x".repeat(600_000)}`);
    const config = await fixtureConfig(root);
    const { searchVault } = await import("../../src/search.js");

    const search = await searchVault({ config, query: "searchable split needle", cache: null });

    expect(search.hits.map((hit) => String(hit.path))).toEqual(["Large.md"]);
    expect(search.hits[0]?.snippet.length).toBeLessThanOrEqual(8_000);
    await expect(readVaultNote({ config, path: "Large.md" })).rejects.toMatchObject({
      name: "VaultReadError",
      code: "note_unreadable",
    });
  });

  it("allows explicit attachment Markdown reads while automatic search excludes attachments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-explicit-attachment-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    await vault.writeNote("_adjuntos/Manual.md", "# Manual\nattachment needle\n");
    const config = await fixtureConfig(root);
    const { searchVault } = await import("../../src/search.js");

    const search = await searchVault({ config, query: "attachment needle", cache: null });
    const explicit = await readVaultNote({ config, path: "_adjuntos/Manual.md" });

    expect(search.hits).toEqual([]);
    expect(explicit.path).toBe("_adjuntos/Manual.md");
    expect(explicit.content).toContain("> attachment needle");
  });

  it("rejects unsafe and reserved explicit paths without leaking their values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-read-paths-"));
    temporaryDirectories.push(root);
    await createVault({ vaultPath: root });
    const config = await fixtureConfig(root);

    for (const unsafe of ["../outside.md", "/absolute.md", ".resyst/journal/event.md", "image.png"]) {
      const request = readVaultNote({ config, path: unsafe });
      await expect(request).rejects.toMatchObject({
        name: "VaultReadError",
        code: "invalid_path",
        message: "vault read path is invalid",
      });
      await expect(request).rejects.not.toThrow(unsafe);
    }
  });

  it("indexes contained note symlinks and rejects escaping targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-search-symlinks-"));
    temporaryDirectories.push(root);
    const vault = await createVault({ vaultPath: root });
    const target = await vault.writeNote("Targets/Contained.md", "# Contained\nsymlink needle\n");
    await vault.createSymlink("Contained-Link.md", target);
    const config = await fixtureConfig(root);
    const { searchVault } = await import("../../src/search.js");

    const contained = await searchVault({ config, query: "symlink needle", cache: null });
    expect(contained.hits.map((hit) => String(hit.path))).toEqual([
      "Contained-Link.md",
      "Targets/Contained.md",
    ]);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-search-outside-"));
    temporaryDirectories.push(outsideRoot);
    const outside = path.join(outsideRoot, "Outside.md");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(outside, "# Outside\nescape needle\n", "utf8"),
    );
    await vault.createSymlink("Escape.md", outside);
    await expect(searchVault({ config, query: "escape needle", cache: null }))
      .rejects.toMatchObject({ name: "SearchError", code: "vault_unreadable" });
  });
});
