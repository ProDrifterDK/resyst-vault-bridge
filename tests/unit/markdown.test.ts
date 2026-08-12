/**
 * Unit tests for the position-aware Obsidian Markdown model
 * (`src/markdown.ts`).
 *
 * The module is a pure text boundary: it parses frontmatter, headings,
 * wikilinks, and managed begin/end markers into source offsets and applies
 * replacement/insertion so that every byte outside the touched managed range
 * stays identical. All content here is synthetic neutral fixture text
 * (user Casey, project Atlas); no real vault is ever read.
 *
 * The tests exercise only the public seam. None of them depend on private
 * helpers, so the parser may be reimplemented as long as the public
 * behavior below holds.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  extractSection,
  findHeading,
  insertManagedBlock,
  MARKER_TEXT_REJECTED_MESSAGE,
  parseNote,
  replaceManagedBlock,
  type FrontmatterResult,
  type HeadingLookupResult,
  type ManagedBlock,
  type ManagedInsertResult,
  type ManagedReplaceResult,
  type ParsedNote,
  type ResystProjectMetadata,
  type SectionLookupResult,
} from "../../src/markdown.js";

/** Shortcut: parse the exact source into the public note model. */
function parse(source: string): ParsedNote {
  return parseNote(source);
}

/** Build a canonical managed-block source with LF line endings. */
function blockSource(body: string, session = "sess-01ab", target = "daily"): string {
  return [
    `# 2026-08-11`,
    ``,
    `## Tareas`,
    ``,
    `<!-- resyst-vault:begin session=${session} target=${target} -->`,
    ...body.split("\n"),
    `<!-- resyst-vault:end session=${session} target=${target} -->`,
    ``,
    `## Reflexión`,
    ``,
  ].join("\n");
}

describe("parseNote frontmatter", () => {
  it("parses quoted YAML frontmatter into narrowed metadata", () => {
    const source = [
      "---",
      'title: "Tareas & Notas"',
      'date: "2026-08-11"',
      "tags:",
      '  - "alfa"',
      '  - "beta"',
      "aliases:",
      '  - "Alias Uno"',
      '  - "Alias Dos"',
      "resyst_project:",
      '  id: "atlas"',
      "  repos:",
      '    - "github.com/tester/atlas"',
      "  aliases:",
      '    - "Atlas"',
      "---",
      "# Nota",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata).toEqual({
        title: "Tareas & Notas",
        date: "2026-08-11",
        tags: ["alfa", "beta"],
        aliases: ["Alias Uno", "Alias Dos"],
        resyst_project: {
          id: "atlas",
          repos: ["github.com/tester/atlas"],
          aliases: ["Atlas"],
        },
      });
      // The frontmatter region carries exact source offsets.
      expect(note.frontmatter.start).toBe(0);
      expect(source.slice(note.frontmatter.start, note.frontmatter.end)).toBe(
        "---\ntitle: \"Tareas & Notas\"\ndate: \"2026-08-11\"\ntags:\n  - \"alfa\"\n  - \"beta\"\naliases:\n  - \"Alias Uno\"\n  - \"Alias Dos\"\nresyst_project:\n  id: \"atlas\"\n  repos:\n    - \"github.com/tester/atlas\"\n  aliases:\n    - \"Atlas\"\n---\n",
      );
    }
  });

  it("reports missing frontmatter when the document has none", () => {
    const note = parse("# Nota\n\nContenido\n");
    expect(note.frontmatter.kind).toBe("missing");
  });

  it("reports missing frontmatter when the opening --- never closes", () => {
    // A lone `---` at the top is a thematic break, not frontmatter.
    const note = parse("---\n# Nota\n");
    expect(note.frontmatter.kind).toBe("missing");
  });

  it("reports invalid frontmatter when the YAML body is malformed", () => {
    const note = parse("---\ntitle: [unclosed\n---\n# Nota\n");
    expect(note.frontmatter.kind).toBe("invalid");
  });

  it("narrows wrong-typed frontmatter fields to absent values", () => {
    const note = parse([
      "---",
      "title: 42",
      "date: true",
      "tags:",
      "  - 7",
      "  - ok",
      "aliases: atlas",
      "resyst_project:",
      "  nested: map",
      "---",
      "# Nota",
      "",
    ].join("\n"));
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata).toEqual({
        title: null,
        date: null,
        tags: ["ok"],
        aliases: ["atlas"],
        resyst_project: null,
      });
    }
  });

  it("handles CRLF frontmatter and reports the CRLF line ending", () => {
    const source = "---\r\ntitle: \"Tareas\"\r\ntags: [\"alfa\", \"beta\"]\r\n---\r\n# Nota\r\n\r\nTexto\r\n";
    const note = parse(source);
    expect(note.line_ending).toBe("\r\n");
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata.title).toBe("Tareas");
      expect(note.frontmatter.metadata.tags).toEqual(["alfa", "beta"]);
      // The exact CRLF bytes of the frontmatter region are preserved.
      expect(source.slice(note.frontmatter.start, note.frontmatter.end)).toBe(
        "---\r\ntitle: \"Tareas\"\r\ntags: [\"alfa\", \"beta\"]\r\n---\r\n",
      );
    }
  });

  it("preserves the exact source slice for a CRLF note with no frontmatter", () => {
    const source = "# Nota\r\n\r\n## Tareas\r\n\r\nTexto\r\n";
    const note = parse(source);
    expect(note.line_ending).toBe("\r\n");
    expect(note.frontmatter.kind).toBe("missing");
  });
});

describe("parseNote headings", () => {
  it("scans ATX headings with Unicode text and correct levels", () => {
    const note = parse("# Inicio\n\n## Reflexión\n\n### Café — mañana\n\n## Enlaces del día\n");
    expect(note.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Inicio"],
      [2, "Reflexión"],
      [3, "Café — mañana"],
      [2, "Enlaces del día"],
    ]);
  });

  it("strips trailing closing hashes from ATX heading text", () => {
    const note = parse("## Tareas ##\n");
    expect(note.headings).toHaveLength(1);
    expect(note.headings[0]?.text).toBe("Tareas");
    expect(note.headings[0]?.level).toBe(2);
  });

  it("scans setext headings into level 1 and level 2 headings", () => {
    const note = parse("Título uno\n==========\n\nSubtítulo\n---------\n");
    expect(note.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Título uno"],
      [2, "Subtítulo"],
    ]);
  });

  it("does not treat a thematic break after a blank line as a setext heading", () => {
    const note = parse("Párrafo\n\n---\n\n# Título\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Título"]);
  });

  it("does not treat --- after a heading as a setext underline", () => {
    const note = parse("## Tareas\n---\n\nTexto\n");
    expect(note.headings.map((h) => [h.level, h.text])).toEqual([[2, "Tareas"]]);
  });

  it("ignores heading-looking lines inside backtick and tilde code fences", () => {
    const note = parse([
      "# Real",
      "",
      "```ts",
      "## Fake inside backticks",
      "```",
      "",
      "~~~",
      "# Fake inside tildes",
      "~~~",
      "",
      "## Real dos",
      "",
    ].join("\n"));
    expect(note.headings.map((h) => h.text)).toEqual(["Real", "Real dos"]);
  });

  it("ignores heading-looking lines inside the frontmatter block", () => {
    const note = parse("---\ntitle: x\n## Fake\n---\n# Real\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("keeps exact source offsets for headings", () => {
    const source = "## Tareas\n\n## Reflexión\n";
    const note = parse(source);
    const tareas = note.headings[0];
    const reflexion = note.headings[1];
    expect(tareas?.start).toBe(0);
    expect(source.slice(tareas?.start ?? 0, tareas?.end ?? 0)).toBe("## Tareas");
    expect(reflexion?.start).toBe(11);
    expect(source.slice(reflexion?.start ?? 0, reflexion?.end ?? 0)).toBe("## Reflexión");
  });
});

describe("findHeading", () => {
  it("finds a heading by full heading text", () => {
    const result = findHeading("# Inicio\n\n## Tareas\n", "## Tareas");
    expect(result.kind).toBe("found");
    expectTypeOf(result).toMatchTypeOf<HeadingLookupResult>();
  });

  it("reports a missing heading without guessing a placement", () => {
    const result = findHeading("# Inicio\n", "## Tareas");
    expect(result.kind).toBe("missing");
  });

  it("reports duplicate headings as typed ambiguity", () => {
    const result = findHeading("## Tareas\n\n## Tareas\n", "## Tareas");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.count).toBe(2);
    }
  });

  it("distinguishes Unicode headings exactly", () => {
    expect(findHeading("## Reflexión\n", "## Reflexión").kind).toBe("found");
    expect(findHeading("## Reflexion\n", "## Reflexión").kind).toBe("missing");
  });
});

describe("parseNote wikilinks", () => {
  it("parses wikilinks with aliases and anchors", () => {
    const note = parse([
      "Ver [[Atlas]] y [[Atlas|proyecto]] y [[Atlas#Estado|estado]].",
      "",
      "Enlace [[Atlas#Estado]] también.",
      "",
    ].join("\n"));
    expect(note.wikilinks.map((w) => [w.target, w.alias, w.anchor])).toEqual([
      ["Atlas", null, null],
      ["Atlas", "proyecto", null],
      ["Atlas", "estado", "Estado"],
      ["Atlas", null, "Estado"],
    ]);
  });

  it("parses heading-only wikilinks with a null target", () => {
    const note = parse("[[#Inicio]]\n");
    expect(note.wikilinks).toEqual([
      { target: null, alias: null, anchor: "Inicio", start: 0, end: 11 },
    ]);
  });

  it("ignores malformed wikilinks without closing brackets or empty targets", () => {
    const note = parse("[[unclosed\n[[]]\n[[|alias]]\n[[Atlas]]\n");
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Atlas"]);
  });

  it("ignores wikilinks inside code fences", () => {
    const note = parse("```\n[[Fake]]\n```\n\n[[Real]]\n");
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });
});

describe("managed marker parsing", () => {
  it("parses one managed block with exact body offsets", () => {
    const source = blockSource("- hecho\n- pendiente");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(1);
      const block = note.managed.blocks[0];
      expect(block?.session_id).toBe("sess-01ab");
      expect(block?.target).toBe("daily");
      expect(source.slice(block?.begin_start ?? 0, block?.begin_end ?? 0)).toBe(
        "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      );
      expect(source.slice(block?.body_start ?? 0, block?.body_end ?? 0)).toBe(
        "- hecho\n- pendiente\n",
      );
      expect(source.slice(block?.end_start ?? 0, block?.end_end ?? 0)).toBe(
        "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      );
    }
  });

  it("ignores markers inside code fences", () => {
    const source = [
      "# Nota",
      "",
      "```",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "código",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "```",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(0);
    }
  });

  it("fails closed on a malformed begin marker missing an attribute", () => {
    const source = "# Nota\n\n<!-- resyst-vault:begin session=sess-01ab -->\n";
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
  });

  it("fails closed on nested managed blocks", () => {
    const source = [
      "# Nota",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "<!-- resyst-vault:end session=a target=daily -->",
      "<!-- resyst-vault:end session=a target=daily -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
    if (note.managed.kind === "malformed") {
      expect(note.managed.reason).toBe("nested");
    }
  });

  it("fails closed on mismatched begin/end markers", () => {
    const source = [
      "# Nota",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "<!-- resyst-vault:end session=b target=daily -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
    if (note.managed.kind === "malformed") {
      expect(note.managed.reason).toBe("mismatched");
    }
  });

  it("fails closed on an orphan end marker", () => {
    const source = "# Nota\n\n<!-- resyst-vault:end session=a target=daily -->\n";
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
    if (note.managed.kind === "malformed") {
      expect(note.managed.reason).toBe("orphan_end");
    }
  });

  it("fails closed on an unclosed begin marker", () => {
    const source = "# Nota\n\n<!-- resyst-vault:begin session=a target=daily -->\n- texto\n";
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
    if (note.managed.kind === "malformed") {
      expect(note.managed.reason).toBe("unclosed");
    }
  });

  it("fails closed on duplicate blocks with the same session and target", () => {
    const source = [
      "# Nota",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "uno",
      "<!-- resyst-vault:end session=a target=daily -->",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "dos",
      "<!-- resyst-vault:end session=a target=daily -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("malformed");
    if (note.managed.kind === "malformed") {
      expect(note.managed.reason).toBe("duplicate");
    }
  });

  it("accepts several fragments sharing one session id under different targets", () => {
    const source = [
      "# Nota",
      "",
      "<!-- resyst-vault:begin session=a target=tareas -->",
      "uno",
      "<!-- resyst-vault:end session=a target=tareas -->",
      "",
      "<!-- resyst-vault:begin session=a target=reflexion -->",
      "dos",
      "<!-- resyst-vault:end session=a target=reflexion -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(2);
    }
  });

  it("fails closed on marker-like text that is not an own-line valid marker", () => {
    const inline = "# Nota\n\ntexto <!-- resyst-vault:begin session=a target=daily -->\n";
    expect(parse(inline).managed.kind).toBe("malformed");
    const truncated = "# Nota\n\n<!-- resyst-vault:begin session=a target=daily\n";
    expect(parse(truncated).managed.kind).toBe("malformed");
  });
});

describe("extractSection", () => {
  it("extracts one selected section as exact source offsets and bytes", () => {
    const source = "# 2026-08-11\n\n## Tareas\n- completado\n\n## Reflexión\n- aprender\n";
    const result = extractSection(source, "## Tareas");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      const section = result.section;
      expect(source.slice(section.heading_start, section.body_start)).toBe("## Tareas\n");
      expect(section.body).toBe("- completado\n\n");
      expect(source.slice(section.section_end)).toBe("## Reflexión\n- aprender\n");
    }
    expectTypeOf(result).toMatchTypeOf<SectionLookupResult>();
  });

  it("extends the section to end of file when no later heading exists", () => {
    const source = "## Tareas\n- completado\n";
    const result = extractSection(source, "## Tareas");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.section.section_end).toBe(source.length);
      expect(result.section.body).toBe("- completado\n");
    }
  });

  it("reports missing and ambiguous sections with typed results", () => {
    expect(extractSection("# Solo\n", "## Tareas").kind).toBe("missing");
    expect(extractSection("## Tareas\n\n## Tareas\n", "## Tareas").kind).toBe("ambiguous");
  });
});

describe("replaceManagedBlock preservation", () => {
  it("replaces only the bounded body; prefix and suffix stay byte-identical", () => {
    const source = blockSource("- hecho\n- pendiente");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    const old = note.managed.kind === "ok" ? note.managed.blocks[0] : undefined;
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- hecho\n- nuevo\n- más",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced" && old) {
      const newBody = "- hecho\n- nuevo\n- más\n";
      // Only the bounded body range differs; prefix/suffix byte-identical.
      expect(result.source).toBe(
        source.slice(0, old.body_start) + newBody + source.slice(old.body_end),
      );
      expect(result.source.slice(0, result.block.body_start)).toBe(
        source.slice(0, old.body_start),
      );
      expect(result.source.slice(result.block.body_start + newBody.length)).toBe(
        source.slice(old.body_end),
      );
      expect(result.source).not.toBe(source);
    }
  });

  it("reports not_found for a missing session/target block", () => {
    const result = replaceManagedBlock(blockSource("x"), "sess-9999", "daily", "nuevo");
    expect(result.kind).toBe("not_found");
    expectTypeOf(result).toMatchTypeOf<ManagedReplaceResult>();
  });

  it("fails closed instead of guessing when the document has malformed markers", () => {
    const source = "# Nota\n\n<!-- resyst-vault:begin session=a target=daily -->\n";
    const result = replaceManagedBlock(source, "a", "daily", "nuevo");
    expect(result.kind).toBe("malformed");
  });

  it("fails closed instead of editing when duplicate blocks exist", () => {
    const source = [
      "# Nota",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "uno",
      "<!-- resyst-vault:end session=a target=daily -->",
      "",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "dos",
      "<!-- resyst-vault:end session=a target=daily -->",
      "",
    ].join("\n");
    const result = replaceManagedBlock(source, "a", "daily", "nuevo");
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toBe("duplicate");
    }
  });

  it("preserves CRLF outside the block and writes CRLF bodies into CRLF notes", () => {
    const source = [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
      "## Reflexión",
      "",
    ].join("\r\n");
    const result = replaceManagedBlock(source, "sess-01ab", "daily", "- nuevo\n- más");
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      expect(result.source.includes("\r\n")).toBe(true);
      expect(result.source).toContain("- nuevo\r\n- más\r\n");
      // The leading section is byte-identical including its CRLF endings.
      const marker = "<!-- resyst-vault:begin session=sess-01ab target=daily -->";
      expect(result.source.slice(0, result.source.indexOf(marker))).toBe(
        source.slice(0, source.indexOf(marker)),
      );
      const tailMarker = "<!-- resyst-vault:end session=sess-01ab target=daily -->";
      const tailStart = result.source.indexOf(tailMarker);
      expect(result.source.slice(tailStart + tailMarker.length)).toBe(
        source.slice(source.indexOf(tailMarker) + tailMarker.length),
      );
    }
  });

  it("rejects marker-like text inside a replacement body", () => {
    const body = "- nuevo\n<!-- resyst-vault:begin session=x target=daily -->\n- más";
    const result = replaceManagedBlock(blockSource("- viejo"), "sess-01ab", "daily", body);
    expect(result.kind).toBe("marker_text_rejected");
    if (result.kind === "marker_text_rejected") {
      expect(result.message).toBe(MARKER_TEXT_REJECTED_MESSAGE);
    }
  });

  it("rejects invalid session or target ids", () => {
    const source = blockSource("- viejo");
    expect(replaceManagedBlock(source, "bad id!", "daily", "nuevo").kind).toBe("invalid_id");
    expect(replaceManagedBlock(source, "sess-01ab", "../escape", "nuevo").kind).toBe(
      "invalid_id",
    );
  });
});

describe("insertManagedBlock", () => {
  it("inserts a new block under exactly one configured heading", () => {
    const source = "# 2026-08-11\n\n## Tareas\n\n## Reflexión\n";
    const result = insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "- hecho");
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      const block = result.block;
      expect(result.source).toBe(
        "# 2026-08-11\n\n## Tareas\n\n" +
          "<!-- resyst-vault:begin session=sess-01ab target=daily -->\n" +
          "- hecho\n" +
          "<!-- resyst-vault:end session=sess-01ab target=daily -->\n\n" +
          "## Reflexión\n",
      );
      // Only bytes were added; everything else is untouched.
      const before = source.slice(0, source.indexOf("## Reflexión"));
      expect(result.source.slice(0, result.source.indexOf("## Reflexión"))).not.toBe(before);
      expect(result.source.slice(result.source.indexOf("## Reflexión"))).toBe("## Reflexión\n");
      expect(block.body_start).toBeGreaterThan(block.begin_end);
      expect(block.body_end).toBe(block.end_start);
    }
    expectTypeOf(result).toMatchTypeOf<ManagedInsertResult>();
  });

  it("returns heading_missing when no configured heading exists", () => {
    const result = insertManagedBlock("# Solo\n", "## Tareas", "sess-01ab", "daily", "x");
    expect(result.kind).toBe("heading_missing");
  });

  it("returns typed ambiguity when the configured heading is duplicated", () => {
    const source = "## Tareas\n\n## Tareas\n";
    const result = insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "x");
    expect(result.kind).toBe("heading_ambiguous");
    if (result.kind === "heading_ambiguous") {
      expect(result.count).toBe(2);
    }
  });

  it("fails closed instead of inserting a duplicate block", () => {
    const source = blockSource("- viejo");
    const result = insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "- nuevo");
    expect(result.kind).toBe("block_exists");
  });

  it("fails closed when the document has malformed markers", () => {
    const source = "# Nota\n\n<!-- resyst-vault:begin session=a target=daily -->\n";
    const result = insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "x");
    expect(result.kind).toBe("malformed");
  });

  it("rejects marker-like text inside an inserted body", () => {
    const body = "- nuevo\n<!-- resyst-vault:end session=x target=daily -->";
    const result = insertManagedBlock(
      "# 2026-08-11\n\n## Tareas\n",
      "## Tareas",
      "sess-01ab",
      "daily",
      body,
    );
    expect(result.kind).toBe("marker_text_rejected");
  });

  it("writes CRLF insertion into a CRLF note", () => {
    const source = "# 2026-08-11\r\n\r\n## Tareas\r\n\r\n## Reflexión\r\n";
    const result = insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "- hecho\n- más");
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      expect(result.source).toContain(
        "<!-- resyst-vault:begin session=sess-01ab target=daily -->\r\n- hecho\r\n- más\r\n",
      );
      // The suffix after the inserted block is byte-identical.
      const suffix = "## Reflexión\r\n";
      expect(result.source.slice(result.source.indexOf(suffix))).toBe(suffix);
    }
  });

  it("rejects invalid ids and unparseable heading text", () => {
    const source = "# Nota\n\n## Tareas\n";
    expect(insertManagedBlock(source, "## Tareas", "bad id", "daily", "x").kind).toBe(
      "invalid_id",
    );
    expect(
      insertManagedBlock(source, "Tareas sin almohadilla", "sess-01ab", "daily", "x").kind,
    ).toBe("invalid_heading");
  });
});

describe("frontmatter typed results", () => {
  it("exposes exact discriminated union kinds for frontmatter", () => {
    expectTypeOf<FrontmatterResult>().toMatchTypeOf<
      | { kind: "present"; metadata: unknown; start: number; end: number }
      | { kind: "missing" }
      | { kind: "invalid" }
    >();
  });
});


describe("frontmatter delimiter region with invalid YAML", () => {
  it("skips heading-looking lines inside an invalid delimited frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "## Tareas",
      "---",
      "# Real",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    expect(note.headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("skips wikilinks inside an invalid delimited frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "[[Fake]]",
      "---",
      "[[Real]]",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });

  it("ignores managed markers inside an invalid delimited frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "<!-- resyst-vault:end session=a target=daily -->",
      "---",
      "# Nota",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(0);
    }
    // markers inside invalid frontmatter are data, not bridge markers, and
    // the whole structurally invalid note fails closed for write operations
    expect(replaceManagedBlock(source, "a", "daily", "x").kind).toBe(
      "invalid_frontmatter",
    );
  });

  it("preserves the exact region offsets of an invalid delimited frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "---",
      "# Real",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    if (note.frontmatter.kind === "invalid") {
      expect(note.frontmatter.start).toBe(0);
      expect(note.source.slice(note.frontmatter.start, note.frontmatter.end)).toBe(
        "---\ntitle: [unclosed\n---\n",
      );
      expect(note.source.slice(note.frontmatter.body_start, note.frontmatter.body_end)).toBe(
        "title: [unclosed\n",
      );
    }
  });

  it("ignores valid- and malformed-looking markers inside invalid YAML", () => {
    const source = [
      "---",
      "title: [unclosed",
      "<!-- resyst-vault:begin session=a target=daily -->",
      "<!-- resyst-vault:end session=b target=daily -->",
      "<!-- resyst-vault:begin session=broken -->",
      "---",
      "# Nota",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    // none of the marker text becomes a document construct
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(0);
    }
    expect(replaceManagedBlock(source, "a", "daily", "x").kind).toBe(
      "invalid_frontmatter",
    );
    expect(
      insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "x").kind,
    ).toBe("invalid_frontmatter");
  });

  it("does not leak a fence-looking line inside invalid frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "```",
      "## Fake inside fence",
      "```",
      "---",
      "# Real",
      "",
      "## Tareas",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    expect(note.headings.map((h) => h.text)).toEqual(["Real", "Tareas"]);
  });

  it("proves write operations cannot target headings inside invalid frontmatter", () => {
    const source = [
      "---",
      "title: [unclosed",
      "## Tareas",
      "---",
      "# Nota",
      "",
    ].join("\n");
    expect(parse(source).frontmatter.kind).toBe("invalid");
    expect(findHeading(source, "## Tareas").kind).toBe("missing");
    expect(extractSection(source, "## Tareas").kind).toBe("missing");
    // write operations fail closed on a structurally invalid note
    expect(
      insertManagedBlock(source, "## Tareas", "sess-01ab", "daily", "x").kind,
    ).toBe("invalid_frontmatter");
    expect(
      replaceManagedBlock(source, "sess-01ab", "daily", "x").kind,
    ).toBe("invalid_frontmatter");
  });

  it("keeps the unclosed-leading--- policy: content after it is scanned normally", () => {
    // A leading `---` with no closing delimiter is a thematic break, so the
    // following heading is live (the region policy is intentional).
    const source = "---\n# Tareas\n\n## Tareas\n";
    expect(parse(source).frontmatter.kind).toBe("missing");
    expect(findHeading(source, "## Tareas").kind).toBe("found");
  });
});

describe("resyst_project object metadata", () => {
  /** Build a note whose frontmatter body is the given lines. */
  function projectSource(body: string): string {
    return `---\n${body}\n---\n# Nota\n`;
  }

  it("narrows the approved portable object with quoted values", () => {
    const note = parse(
      projectSource([
        "resyst_project:",
        '  id: "atlas"',
        "  repos:",
        '    - "github.com/tester/atlas"',
        "  aliases:",
        '    - "Atlas"',
      ].join("\n")),
    );
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata.resyst_project).toEqual({
        id: "atlas",
        repos: ["github.com/tester/atlas"],
        aliases: ["Atlas"],
      });
      expectTypeOf(note.frontmatter.metadata.resyst_project).toEqualTypeOf<
        ResystProjectMetadata | null
      >();
      // the delimited region bytes are preserved exactly
      expect(note.source.slice(note.frontmatter.start, note.frontmatter.end)).toBe(
        `---\n${[
          "resyst_project:",
          '  id: "atlas"',
          "  repos:",
          '    - "github.com/tester/atlas"',
          "  aliases:",
          '    - "Atlas"',
        ].join("\n")}\n---\n`,
      );
    }
  });

  it("does not copy unknown nested keys", () => {
    const note = parse(
      projectSource([
        "resyst_project:",
        "  id: atlas",
        "  secret_token: hunter2",
        "  repos:",
        "    - github.com/tester/atlas",
        "  aliases:",
        "    - Atlas",
      ].join("\n")),
    );
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata.resyst_project).toEqual({
        id: "atlas",
        repos: ["github.com/tester/atlas"],
        aliases: ["Atlas"],
      });
    }
  });

  it("rejects malformed resyst_project values deterministically", () => {
    const malformed: string[] = [
      'resyst_project: "atlas"',
      "resyst_project: 42",
      "resyst_project:",
      "resyst_project:\n  id: 42",
      "resyst_project:\n  id: 'bad id!'",
      "resyst_project:\n  id: '../escape'",
      "resyst_project:\n  repos:\n    - github.com/tester/atlas",
    ];
    for (const body of malformed) {
      const note = parse(projectSource(body));
      expect(note.frontmatter.kind).toBe("present");
      if (note.frontmatter.kind === "present") {
        expect(note.frontmatter.metadata.resyst_project).toBeNull();
      }
    }
  });

  it("rejects the whole value when a present array is not a string array", () => {
    // Mixed-type, empty-string, overlong, and scalar entries all reject the
    // entire resyst_project value to null; partial metadata is never kept.
    const malformed: string[] = [
      "resyst_project:\n  id: atlas\n  repos:\n    - 7\n    - github.com/tester/atlas",
      "resyst_project:\n  id: atlas\n  repos:\n    - \n    - github.com/tester/atlas",
      "resyst_project:\n  id: atlas\n  repos: github.com/tester/atlas",
      "resyst_project:\n  id: atlas\n  aliases: Atlas",
      "resyst_project:\n  id: atlas\n  repos: { nested: map }",
      "resyst_project:\n  id: atlas\n  repos: null",
      "resyst_project:\n  id: atlas\n  aliases:",
    ];
    for (const body of malformed) {
      const note = parse(projectSource(body));
      expect(note.frontmatter.kind).toBe("present");
      if (note.frontmatter.kind === "present") {
        expect(note.frontmatter.metadata.resyst_project).toBeNull();
      }
    }
  });

  it("accepts id-only and empty-array metadata as exact output arrays", () => {
    const idOnly = parse(
      projectSource("resyst_project:\n  id: atlas"),
    );
    expect(idOnly.frontmatter.kind).toBe("present");
    if (idOnly.frontmatter.kind === "present") {
      expect(idOnly.frontmatter.metadata.resyst_project).toEqual({
        id: "atlas",
        repos: [],
        aliases: [],
      });
    }
    const emptyArrays = parse(
      projectSource("resyst_project:\n  id: atlas\n  repos: []\n  aliases: []"),
    );
    expect(emptyArrays.frontmatter.kind).toBe("present");
    if (emptyArrays.frontmatter.kind === "present") {
      expect(emptyArrays.frontmatter.metadata.resyst_project).toEqual({
        id: "atlas",
        repos: [],
        aliases: [],
      });
    }
  });

  it("bounds overlong strings and oversized lists by rejecting the value", () => {
    const long = "r".repeat(2000);
    const many = Array.from({ length: 70 }, (_, i) => `alias-${i}`);
    for (const body of [
      "resyst_project:\n  id: atlas\n  repos:\n    - " + long,
      "resyst_project:\n  id: atlas\n  aliases:\n" + many.map((a) => `    - ${a}`).join("\n"),
    ]) {
      const note = parse(projectSource(body));
      expect(note.frontmatter.kind).toBe("present");
      if (note.frontmatter.kind === "present") {
        expect(note.frontmatter.metadata.resyst_project).toBeNull();
      }
    }
  });
});

describe("replaceManagedBlock returned offsets", () => {
  const begin = "<!-- resyst-vault:begin session=sess-01ab target=daily -->";
  const end = "<!-- resyst-vault:end session=sess-01ab target=daily -->";

  /** Assert every offset/slice of a block is consistent with its source. */
  function assertConsistent(
    source: string,
    block: ManagedBlock,
    expectedBody: string,
  ): void {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    expect(source.slice(block.begin_start, block.begin_end)).toBe(begin);
    expect(block.body_start).toBe(block.begin_end + eol.length);
    expect(source.slice(block.body_start, block.body_end)).toBe(expectedBody);
    expect(block.end_start).toBe(block.body_end);
    expect(source.slice(block.end_start, block.end_end)).toBe(end);
  }

  function oldBlockOf(source: string): ManagedBlock {
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      return note.managed.blocks[0]!;
    }
    throw new Error("fixture must contain one managed block");
  }

  it("returns a block consistent with the new source for a shorter LF replacement", () => {
    const source = blockSource("- hecho\n- pendiente");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(source, "sess-01ab", "daily", "- corto");
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const newBody = "- corto\n";
      assertConsistent(result.source, result.block, newBody);
      // offsets before the body are unchanged
      expect(result.block.begin_start).toBe(old.begin_start);
      expect(result.block.begin_end).toBe(old.begin_end);
      expect(result.block.body_start).toBe(old.body_start);
      // prefix and suffix stay byte-identical
      expect(result.source.slice(0, result.block.body_start)).toBe(
        source.slice(0, old.body_start),
      );
      expect(result.source.slice(result.block.body_start + newBody.length)).toBe(
        source.slice(old.body_end),
      );
      expect(result.source).toBe(
        source.slice(0, old.body_start) + newBody + source.slice(old.body_end),
      );
    }
  });

  it("returns a block consistent with the new source for a longer LF replacement", () => {
    const source = blockSource("- hecho");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- hecho\n- mucho más contenido\n- y todavía más",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const newBody = "- hecho\n- mucho más contenido\n- y todavía más\n";
      assertConsistent(result.source, result.block, newBody);
      expect(result.source).toBe(
        source.slice(0, old.body_start) + newBody + source.slice(old.body_end),
      );
    }
  });

  it("returns a block consistent with the new source for CRLF replacements", () => {
    const source = [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
      "## Reflexión",
      "",
    ].join("\r\n");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(source, "sess-01ab", "daily", "- nuevo");
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const newBody = "- nuevo\r\n";
      assertConsistent(result.source, result.block, newBody);
      expect(result.source).toBe(
        source.slice(0, old.body_start) + newBody + source.slice(old.body_end),
      );
      expect(result.source.slice(result.block.end_end)).toBe(
        source.slice(old.end_end),
      );
    }
  });
});

describe("body line-ending normalization", () => {
  function crlfSource(body: string): string {
    return [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      ...body.split("\n"),
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
      "## Reflexión",
      "",
    ].join("\r\n");
  }

  function oldBlockOf(source: string): ManagedBlock {
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      return note.managed.blocks[0]!;
    }
    throw new Error("fixture must contain one managed block");
  }

  it("normalizes CRLF and lone-CR body endings into an LF note on replace", () => {
    const source = blockSource("- hecho");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\r\n- b\r- c\n- d",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\n- b\n- c\n- d\n");
      expect(body.includes("\r")).toBe(false);
      // outside bytes stay exact
      expect(result.source).toBe(
        source.slice(0, old.body_start) + "- a\n- b\n- c\n- d\n" + source.slice(old.body_end),
      );
    }
  });

  it("normalizes mixed body endings into a CRLF note on replace", () => {
    const source = crlfSource("- hecho");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\n- b\r\n- c\r- d",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\r\n- b\r\n- c\r\n- d\r\n");
      expect(result.source).toBe(
        source.slice(0, old.body_start) + body + source.slice(old.body_end),
      );
    }
  });

  it("normalizes mixed body endings into an LF note on insert", () => {
    const source = "# Nota\n\n## Tareas\n";
    const result = insertManagedBlock(
      source,
      "## Tareas",
      "sess-01ab",
      "daily",
      "- a\r\n- b\r- c\n- d",
    );
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\n- b\n- c\n- d\n");
    }
  });

  it("normalizes mixed body endings into a CRLF note on insert", () => {
    const source = "# Nota\r\n\r\n## Tareas\r\n";
    const result = insertManagedBlock(
      source,
      "## Tareas",
      "sess-01ab",
      "daily",
      "- a\n- b\r\n- c\r- d",
    );
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\r\n- b\r\n- c\r\n- d\r\n");
    }
  });

  it("preserves CR-only documents and writes CR-only bodies", () => {
    const source = [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
      "## Reflexión",
      "",
    ].join("\r");
    const note = parse(source);
    expect(note.line_ending).toBe("\r");
    const old = oldBlockOf(source);
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\n- b\r\n- c\r- d",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\r- b\r- c\r- d\r");
      expect(body.includes("\n")).toBe(false);
      expect(result.source).toBe(
        source.slice(0, old.body_start) + body + source.slice(old.body_end),
      );
    }
  });

  it("inserts into a CR-only note with CR separators", () => {
    const source = "# Nota\r\r## Tareas\r";
    const result = insertManagedBlock(
      source,
      "## Tareas",
      "sess-01ab",
      "daily",
      "- a\n- b",
    );
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      const body = result.source.slice(
        result.block.body_start,
        result.block.body_end,
      );
      expect(body).toBe("- a\r- b\r");
      expect(
        result.source.slice(result.block.end_end),
      ).toBe("\r");
      expect(result.source).toContain(
        "<!-- resyst-vault:begin session=sess-01ab target=daily -->\r- a\r- b\r",
      );
    }
  });
});

describe("fence info strings", () => {
  it("does not treat a backtick fence whose info string contains a backtick as a fence", () => {
    const note = parse("```foo`bar\n\n## Tareas\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Tareas"]);
  });

  it("validates managed markers after a false fence opener", () => {
    const source = [
      "```foo`bar",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(1);
    }
    expect(replaceManagedBlock(source, "sess-01ab", "daily", "- nuevo").kind).toBe(
      "replaced",
    );
  });

  it("still suppresses content behind valid backtick and tilde fences", () => {
    const source = [
      "```",
      "## Hidden backtick",
      "```",
      "",
      "~~~foo`bar",
      "## Hidden tilde",
      "~~~",
      "",
      "## Visible",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.headings.map((h) => h.text)).toEqual(["Visible"]);
  });

  it("inserts exactly one block when a false fence opener precedes the heading", () => {
    const source = "```foo`bar\n\n## Tareas\n";
    const first = insertManagedBlock(
      source,
      "## Tareas",
      "sess-01ab",
      "daily",
      "- uno",
    );
    expect(first.kind).toBe("inserted");
    if (first.kind === "inserted") {
      const note = parse(first.source);
      expect(note.managed.kind).toBe("ok");
      if (note.managed.kind === "ok") {
        expect(note.managed.blocks).toHaveLength(1);
      }
      expect(
        insertManagedBlock(
          first.source,
          "## Tareas",
          "sess-01ab",
          "daily",
          "- dos",
        ).kind,
      ).toBe("block_exists");
    }
  });
});


describe("indented code exclusion", () => {
  it("does not treat a 4-space-indented heading-like line as a heading", () => {
    const note = parse("    ## Fake\n\n## Real\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("does not make an indented paragraph+underline a setext heading", () => {
    const note = parse("    Párrafo\n    ---\n\n# Real\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("ignores markers inside indented code without failing closed", () => {
    const source = [
      "# Nota",
      "",
      "    <!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "    <!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.managed.kind).toBe("ok");
    if (note.managed.kind === "ok") {
      expect(note.managed.blocks).toHaveLength(0);
    }
    expect(replaceManagedBlock(source, "sess-01ab", "daily", "x").kind).toBe(
      "not_found",
    );
  });

  it("ignores wikilinks inside indented code", () => {
    const note = parse("    [[Fake]]\n\n[[Real]]\n");
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });

  it("ignores tab-indented heading-like lines", () => {
    const note = parse("\t## Fake\n\n## Real\n");
    expect(note.headings.map((h) => h.text)).toEqual(["Real"]);
  });
});

describe("wikilink boundaries", () => {
  it("ignores wikilinks inside balanced inline code spans of variable run length", () => {
    const note = parse(
      "`[[Uno]]` y ``[[Dos]]`` y ```[[Tres]]``` y [[Cuatro]]\n",
    );
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Cuatro"]);
  });

  it("does not close a link with a ] pair inside an inline code span", () => {
    const note = parse("[[a `]]` b]]\n");
    // the first ]] is inside code and does not close; the final ]] does
    expect(note.wikilinks.map((w) => w.target)).toEqual(["a `]]` b"]);
  });

  it("rejects nested wikilinks as malformed", () => {
    const note = parse("[[a [[b]] c]]\n");
    // the outer link is rejected; the inner standalone link remains
    expect(note.wikilinks.map((w) => w.target)).toEqual(["b"]);
  });

  it("rejects links whose inner text carries marker-like brackets", () => {
    const note = parse("[[a <!-- resyst-vault:begin --> b]]\n\n[[Ok]]\n");
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Ok"]);
  });
});

describe("wikilink scan bound", () => {
  it("scans adversarial openers and fences in bounded time", () => {
    const started = Date.now();
    const manyOpeners = "[[".repeat(20_000) + "\n\n## Tareas\n";
    const note = parse(manyOpeners);
    expect(note.wikilinks).toHaveLength(0);
    expect(note.headings.map((h) => h.text)).toEqual(["Tareas"]);

    const manyFences = ("```\n".repeat(10_000)) + "## Visible\n";
    const fenced = parse(manyFences);
    expect(fenced.headings.map((h) => h.text)).toEqual(["Visible"]);
    // generous practical bound; linear scan completes in milliseconds
    expect(Date.now() - started).toBeLessThan(4000);
  });
});


describe("exclusion region ordering", () => {
  it("excludes frontmatter wikilinks even when a later fence exists", () => {
    const source = [
      "---",
      "title: atlas",
      "[[FakeInFrontmatter]]",
      "---",
      "# Nota",
      "",
      "```",
      "[[FakeInFence]]",
      "```",
      "",
      "[[Real]]",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });

  it("excludes invalid-frontmatter wikilinks when fences are interleaved", () => {
    const source = [
      "---",
      "title: [unclosed",
      "[[FakeInInvalid]]",
      "---",
      "# Nota",
      "",
      "```",
      "[[FakeInFence]]",
      "```",
      "",
      "[[Real]]",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("invalid");
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });

  it("excludes indented wikilinks before and after fences", () => {
    const source = [
      "    [[IndentedBefore]]",
      "",
      "```",
      "[[InFence]]",
      "```",
      "",
      "    [[IndentedAfter]]",
      "",
      "[[Real]]",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });

  it("excludes multiple interleaved fence and indented regions", () => {
    const source = [
      "    [[IndentedOne]]",
      "",
      "```",
      "[[FenceOne]]",
      "```",
      "",
      "    [[IndentedTwo]]",
      "",
      "~~~",
      "[[FenceTwo]]",
      "~~~",
      "",
      "[[Real]]",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Real"]);
  });
});

describe("exact single trailing body break", () => {
  it("collapses multiple trailing CRLF breaks into one on an LF note", () => {
    const source = blockSource("- hecho");
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\r\n- b\r\n\r\n\r\n",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      expect(
        result.source.slice(result.block.body_start, result.block.body_end),
      ).toBe("- a\n- b\n");
    }
  });

  it("collapses multiple trailing mixed breaks on a CRLF note", () => {
    const source = [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
      "## Reflexión",
      "",
    ].join("\r\n");
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\n- b\n\n\r\n\n",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      expect(
        result.source.slice(result.block.body_start, result.block.body_end),
      ).toBe("- a\r\n- b\r\n");
    }
  });

  it("collapses multiple trailing breaks on a CR-only note", () => {
    const source = [
      "# 2026-08-11",
      "",
      "## Tareas",
      "",
      "<!-- resyst-vault:begin session=sess-01ab target=daily -->",
      "- hecho",
      "<!-- resyst-vault:end session=sess-01ab target=daily -->",
      "",
    ].join("\r");
    const result = replaceManagedBlock(source, "sess-01ab", "daily", "- a\n- b\r\r\r");
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      expect(
        result.source.slice(result.block.body_start, result.block.body_end),
      ).toBe("- a\r- b\r");
    }
  });

  it("keeps intentional internal blank lines while collapsing trailing breaks", () => {
    const source = blockSource("- hecho");
    const result = replaceManagedBlock(
      source,
      "sess-01ab",
      "daily",
      "- a\n\n- b\n\n\n\n",
    );
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      expect(
        result.source.slice(result.block.body_start, result.block.body_end),
      ).toBe("- a\n\n- b\n");
    }
  });

  it("inserts with exactly one trailing break after collapsing", () => {
    const source = "# Nota\n\n## Tareas\n";
    const result = insertManagedBlock(
      source,
      "## Tareas",
      "sess-01ab",
      "daily",
      "- a\n- b\r\n\r\n",
    );
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      expect(
        result.source.slice(result.block.body_start, result.block.body_end),
      ).toBe("- a\n- b\n");
    }
  });
});


describe("inline code spans on later lines", () => {
  it("excludes inline-code wikilinks on later lines (LF)", () => {
    const source = "[[Antes]]\n\n`[[Dos]]`\n\n``[[Tres]]``\n\n[[Despues]]\n";
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Antes", "Despues"]);
  });

  it("excludes inline-code wikilinks on later lines (CRLF)", () => {
    const source = "[[Antes]]\r\n\r\n`[[Dos]]`\r\n\r\n``[[Tres]]``\r\n\r\n[[Despues]]\r\n";
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Antes", "Despues"]);
  });

  it("excludes inline-code wikilinks on later lines (CR)", () => {
    const source = "[[Antes]]\r\r`[[Dos]]`\r\r``[[Tres]]``\r\r[[Despues]]\r";
    const note = parse(source);
    expect(note.wikilinks.map((w) => w.target)).toEqual(["Antes", "Despues"]);
  });
});

describe("frontmatter scalar bounds", () => {
  it("bounds scalar title and date values at the string limit", () => {
    const atLimit = "t".repeat(1024);
    const overLimit = "t".repeat(1025);
    const sourceAt = `---\ntitle: ${atLimit}\ndate: ${"d".repeat(1024)}\n---\n# Nota\n`;
    const noteAt = parse(sourceAt);
    expect(noteAt.frontmatter.kind).toBe("present");
    if (noteAt.frontmatter.kind === "present") {
      expect(noteAt.frontmatter.metadata.title).toBe(atLimit);
      expect(noteAt.frontmatter.metadata.date).toBe("d".repeat(1024));
    }
    const sourceOver = `---\ntitle: ${overLimit}\ndate: ${"d".repeat(1025)}\n---\n# Nota\n`;
    const noteOver = parse(sourceOver);
    expect(noteOver.frontmatter.kind).toBe("present");
    if (noteOver.frontmatter.kind === "present") {
      expect(noteOver.frontmatter.metadata.title).toBeNull();
      expect(noteOver.frontmatter.metadata.date).toBeNull();
    }
  });

  it("narrows empty and overlong scalar tags/aliases to empty arrays", () => {
    const source = [
      "---",
      'title: ""',
      "tags: ''",
      "aliases: " + "a".repeat(1025),
      "---",
      "# Nota",
      "",
    ].join("\n");
    const note = parse(source);
    expect(note.frontmatter.kind).toBe("present");
    if (note.frontmatter.kind === "present") {
      expect(note.frontmatter.metadata.title).toBeNull();
      expect(note.frontmatter.metadata.tags).toEqual([]);
      expect(note.frontmatter.metadata.aliases).toEqual([]);
    }
  });
});
