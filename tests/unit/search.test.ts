import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/config.js";
import {
  nodeSearchCacheStore,
  nodeSearchFs,
  searchVault,
} from "../../src/search.js";
import type { HostId } from "../../src/types.js";

const temporaryDirectories: string[] = [];

async function makeConfig(): Promise<{ root: string; config: BridgeConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-search-unit-"));
  temporaryDirectories.push(root);
  const identity = await stat(root, { bigint: true });
  return {
    root,
    config: {
      version: 1,
      host_id: "casey" as HostId,
      vault_path: root,
      vault_identity: {
        real_path: await realpath(root),
        dev: identity.dev,
        ino: identity.ino,
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
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("searchVault", () => {
  it("matches a Markdown note by filename through the public search seam", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Atlas.md"), "# Project Atlas\n\nCurrent launch state.\n", "utf8");

    const result = await searchVault({ config, query: "atlas", cache: null });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.path).toBe("Atlas.md");
    expect(result.hits[0]?.matched_on).toContain("filename");
    expect(result.hits[0]?.snippet).toContain("[BEGIN UNTRUSTED USER KNOWLEDGE");
    expect(result.hits[0]?.snippet).toContain("> source path: Atlas.md");
  });

  it("matches all lexical fields with Unicode normalization and deterministic scoring", async () => {
    const { root, config } = await makeConfig();
    await writeFile(
      path.join(root, "Filename-Atlas.md"),
      "---\ntitle: Launchpad\naliases: [North Star]\n---\n# Heading\n[[Roadmap|Atlas Link]]\nThe café manifest is ready.\n",
      "utf8",
    );
    await writeFile(path.join(root, "Tie-B.md"), "# Atlas\n", "utf8");
    await writeFile(path.join(root, "Tie-A.md"), "# Atlas\n", "utf8");

    const filename = await searchVault({ config, query: "filename atlas", cache: null });
    const title = await searchVault({ config, query: "LAUNCHPAD", cache: null });
    const alias = await searchVault({ config, query: "north_star", cache: null });
    const wikilink = await searchVault({ config, query: "atlas link", cache: null });
    const content = await searchVault({ config, query: "cafe\u0301 MANIFEST", cache: null });
    const ties = await searchVault({ config, query: "atlas", cache: null });

    const fieldsFor = (result: Awaited<ReturnType<typeof searchVault>>) =>
      result.hits.find((hit) => hit.path === "Filename-Atlas.md")?.matched_on;
    expect(fieldsFor(filename)).toContain("filename");
    expect(fieldsFor(title)).toContain("title");
    expect(fieldsFor(alias)).toContain("alias");
    expect(fieldsFor(wikilink)).toContain("wikilink");
    expect(fieldsFor(content)).toContain("content");
    const tiePaths = ties.hits.map((hit) => String(hit.path));
    expect(tiePaths.indexOf("Tie-A.md")).toBeLessThan(tiePaths.indexOf("Tie-B.md"));
    const tieA = ties.hits.find((hit) => hit.path === "Tie-A.md");
    const tieB = ties.hits.find((hit) => hit.path === "Tie-B.md");
    expect(tieA?.score).toBe(tieB?.score);
  });

  it("caps results and ignores automatic-read exclusions", async () => {
    const { root, config } = await makeConfig();
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(root, `Match-${String(index).padStart(2, "0")}.md`), "# Match\nneedle\n", "utf8");
    }
    const ignored = [
      ["_adjuntos", "Attachment.md"],
      [".git", "Git.md"],
      [".stfolder", "State.md"],
      [".resyst", "Journal.md"],
    ] as const;
    for (const [directory, filename] of ignored) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, filename), "# needle ignored\n", "utf8");
    }
    await writeFile(path.join(root, "Note.sync-conflict-20260812.md"), "# needle conflict\n", "utf8");
    await writeFile(path.join(root, "binary.md"), "needle\u0000binary", "utf8");
    await writeFile(path.join(root, "image.png"), "needle", "utf8");

    const result = await searchVault({ config, query: "needle", limit: 5, cache: null });

    expect(result.hits).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.scanned_notes).toBe(40);
    expect(result.hits.map((hit) => String(hit.path))).toEqual([
      "Match-00.md",
      "Match-01.md",
      "Match-02.md",
      "Match-03.md",
      "Match-04.md",
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("rejects hostile queries and bounds quoted snippets", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Long.md"), `# Long\nneedle ${"x".repeat(20_000)}\n`, "utf8");

    await expect(searchVault({ config, query: "   ", cache: null })).rejects.toMatchObject({
      name: "SearchError",
      code: "invalid_query",
      message: "search query is invalid",
    });
    await expect(searchVault({ config, query: "x".repeat(257), cache: null })).rejects.toMatchObject({
      code: "invalid_query",
    });

    const result = await searchVault({ config, query: "needle", cache: null });
    expect(result.hits[0]?.snippet.length).toBeLessThanOrEqual(8_000);
    expect(result.hits[0]?.snippet_truncated).toBe(true);
    expect(result.hits[0]?.snippet).toContain("[END UNTRUSTED USER KNOWLEDGE]");
  });

  it("uses regenerable cache metadata and rebuilds stale or corrupt entries", async () => {
    const { root, config } = await makeConfig();
    const notePath = path.join(root, "Cached.md");
    await writeFile(notePath, "# Cached\nfirst needle\n", "utf8");
    let stored: unknown = null;
    let writes = 0;
    const cache = {
      async read(): Promise<unknown> {
        return stored;
      },
      async write(serialized: string): Promise<void> {
        stored = serialized;
        writes += 1;
      },
    };

    const first = await searchVault({ config, query: "first needle", cache });
    const second = await searchVault({ config, query: "first needle", cache });
    expect(first.cache).toBe("rebuilt");
    expect(second.cache).toBe("hit");
    expect(writes).toBe(1);

    await writeFile(notePath, "# Cached\nsecond needle with changed size\n", "utf8");
    const stale = await searchVault({ config, query: "second needle", cache });
    expect(stale.cache).toBe("rebuilt");
    expect(stale.hits.map((hit) => String(hit.path))).toEqual(["Cached.md"]);

    stored = "{not json";
    const corrupt = await searchVault({ config, query: "second needle", cache });
    expect(corrupt.cache).toBe("rebuilt");
    expect(corrupt.hits).toHaveLength(1);
  });

  it("indexes large notes within the dedicated search budget", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Large.md"), `# Large\nneedle\n${"x".repeat(1_200_000)}`, "utf8");

    const result = await searchVault({ config, query: "needle", cache: null });

    expect(result.hits.map((hit) => String(hit.path))).toEqual(["Large.md"]);
    expect(result.hits[0]?.snippet.length).toBeLessThanOrEqual(8_000);
  });

  it("maps hostile or oversized vault input to one fixed redacted search error", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Huge.md"), `# Huge\nneedle\n${"x".repeat(2_100_000)}`, "utf8");

    await expect(searchVault({ config, query: "needle", cache: null })).rejects.toMatchObject({
      name: "SearchError",
      code: "vault_unreadable",
      message: "vault search is unavailable",
    });
  });

  it("atomically persists cache files outside the vault", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-cache-state-"));
    temporaryDirectories.push(stateRoot);
    const cache = nodeSearchCacheStore({ xdgStateHome: stateRoot, cacheName: "unit.json" });

    expect(await cache.read()).toBeNull();
    await cache.write("{\"version\":1}");

    expect(await cache.read()).toBe("{\"version\":1}");
    const files = await readdir(path.join(stateRoot, "resyst-vault", "cache"));
    expect(files).toEqual(["unit.json"]);
  });

  it("reuses unchanged cached note text without rereading the note", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Reusable.md"), "# Reusable\ncache needle\n", "utf8");
    let stored: unknown = null;
    let reads = 0;
    const cache = {
      async read(): Promise<unknown> { return stored; },
      async write(serialized: string): Promise<void> { stored = serialized; },
    };
    const fs = {
      ...nodeSearchFs,
      async readFileBounded(filePath: string, maxBytes: number): Promise<string> {
        reads += 1;
        return nodeSearchFs.readFileBounded(filePath, maxBytes);
      },
    };

    await searchVault({ config, query: "cache needle", cache, fs });
    expect(reads).toBe(1);
    const cached = await searchVault({ config, query: "cache needle", cache, fs });

    expect(cached.cache).toBe("hit");
    expect(cached.hits).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it("quotes a relevant bounded snippet with heading and mtime provenance", async () => {
    const { root, config } = await makeConfig();
    await writeFile(
      path.join(root, "Relevant.md"),
      `# Relevant\n${"irrelevant preface ".repeat(600)}\n## Current State\nneedle target line\n`,
      "utf8",
    );

    const result = await searchVault({ config, query: "needle target", cache: null });
    const hit = result.hits[0];

    expect(hit?.heading).toBe("Current State");
    expect(hit?.snippet).toContain("> selected heading: Current State");
    expect(hit?.snippet).toContain("> modified at: ");
    expect(hit?.snippet).toContain("> needle target line");
    expect(hit?.snippet).not.toContain("irrelevant preface");
  });

  it("does not treat blank values or blank lines as lexical matches", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Blank.md"), "", "utf8");
    await writeFile(
      path.join(root, "Target.md"),
      "---\ntitle: Alpha\n---\n# Target\n\n\n## Current\nactual needle line\n",
      "utf8",
    );

    const result = await searchVault({ config, query: "actual needle", cache: null });

    expect(result.hits.map((hit) => String(hit.path))).toEqual(["Target.md"]);
    expect(result.hits[0]?.heading).toBe("Current");
    expect(result.hits[0]?.snippet).toContain("> actual needle line");
  });

  it("falls back to direct bounded results when cache persistence fails", async () => {
    const { root, config } = await makeConfig();
    await writeFile(path.join(root, "Fallback.md"), "# Fallback\ncache failure needle\n", "utf8");
    const cache = {
      async read(): Promise<unknown> { throw new Error("cache unavailable"); },
      async write(_serialized: string): Promise<void> { throw new Error("cache read only"); },
    };

    const result = await searchVault({ config, query: "cache failure", cache });

    expect(result.cache).toBe("bypassed");
    expect(result.hits.map((hit) => String(hit.path))).toEqual(["Fallback.md"]);
  });
});
