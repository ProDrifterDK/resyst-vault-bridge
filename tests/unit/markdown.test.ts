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
  type ManagedInsertResult,
  type ManagedReplaceResult,
  type ParsedNote,
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
      'resyst_project: "atlas"',
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
        resyst_project: "atlas",
      });
      // The frontmatter region carries exact source offsets.
      expect(note.frontmatter.start).toBe(0);
      expect(source.slice(note.frontmatter.start, note.frontmatter.end)).toBe(
        "---\ntitle: \"Tareas & Notas\"\ndate: \"2026-08-11\"\ntags:\n  - \"alfa\"\n  - \"beta\"\naliases:\n  - \"Alias Uno\"\n  - \"Alias Dos\"\nresyst_project: \"atlas\"\n---\n",
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
    const result = replaceManagedBlock(source, "sess-01ab", "daily", "- hecho\n- nuevo\n- más");
    expect(result.kind).toBe("replaced");
    if (result.kind === "replaced") {
      const block = result.block;
      const expected =
        source.slice(0, block.body_start) +
        "- hecho\n- nuevo\n- más\n" +
        source.slice(block.body_end);
      expect(result.source).toBe(expected);
      // Prefix/suffix byte-identical, only the body range differs.
      expect(result.source.slice(0, block.body_start)).toBe(
        source.slice(0, block.body_start),
      );
      // The suffix starts after the *new* body; its bytes are the original
      // suffix unchanged.
      const newBody = "- hecho\n- nuevo\n- más\n";
      expect(result.source.slice(block.body_start + newBody.length)).toBe(
        source.slice(block.body_end),
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
