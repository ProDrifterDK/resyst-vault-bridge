/**
 * Position-aware Obsidian Markdown model with exact manual preservation.
 *
 * This module is the pure text boundary of the bridge core (Task 3). It
 * parses a note into source offsets — YAML frontmatter, ATX/setext
 * headings, wikilinks, and managed begin/end markers — and applies two
 * write operations (replace an existing managed block body, insert a new
 * managed block under exactly one configured heading) so that every byte
 * outside the touched range stays byte-identical, including CRLF line
 * endings.
 *
 * Safety contract (fail closed):
 * - Frontmatter is parsed as `unknown` and narrowed only to
 *   title/date/tags/aliases/resyst_project; malformed YAML is reported as
 *   `invalid`, never guessed.
 * - Heading scanning ignores fenced code blocks (backtick and tilde
 *   variants) and the frontmatter block.
 * - Managed markers inside code fences are ignored; malformed, nested,
 *   mismatched, orphaned, unclosed, or duplicate markers make every write
 *   operation return a typed error instead of editing the note.
 * - Replacement may alter only the bounded block body; insertion happens
 *   only under exactly one configured heading (missing or duplicate
 *   headings are typed results, never guessed placements).
 * - Bodies containing marker-like text are rejected so the model can never
 *   forge bridge-owned markers.
 *
 * All external input arrives as strings; IDs are validated against the
 * shared opaque-ID pattern. No explicit `any` is used anywhere in this
 * module: every parse result is a narrowed value or a typed error.
 */
import { parse as parseYaml } from "yaml";
import { ID_PATTERN } from "./schemas.js";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Narrowed frontmatter metadata: only the five allowed fields survive. */
export interface NoteMetadata {
  title: string | null;
  date: string | null;
  tags: string[];
  aliases: string[];
  resyst_project: string | null;
}

/**
 * Frontmatter parse outcome. `present` carries the exact source offsets of
 * the whole `---`-delimited block (start at offset 0, end after the closing
 * delimiter's line ending) plus the body range.
 */
export type FrontmatterResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | {
      kind: "present";
      metadata: NoteMetadata;
      start: number;
      end: number;
      body_start: number;
      body_end: number;
    };

/** One heading occurrence with exact source offsets. */
export interface HeadingOccurrence {
  /** Heading text without the ATX/setext markers, trimmed. */
  text: string;
  /** 1-6 for ATX, or 1 (`===`) / 2 (`---`) for setext. */
  level: number;
  /** Offset of the heading line start (marker start for ATX). */
  start: number;
  /** Offset just past the last content character of the heading line. */
  end: number;
  /** Offset just past the heading line ending (start of the next line). */
  line_end: number;
}

/** One well-formed wikilink with exact source offsets. */
export interface Wikilink {
  /** Link target, or null for heading-only links (`[[#Inicio]]`). */
  target: string | null;
  /** Anchor after `#`, or null. */
  anchor: string | null;
  /** Alias after `|`, or null. */
  alias: string | null;
  /** Offset of the opening `[[`. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
}

/** One managed block delimited by bridge-owned begin/end markers. */
export interface ManagedBlock {
  /** Opaque session id from the markers. */
  session_id: string;
  /** Opaque target id from the markers. */
  target: string;
  /** Offset of the begin marker `<!--`. */
  begin_start: number;
  /** Offset just past the begin marker `-->` (before its line ending). */
  begin_end: number;
  /** Offset of the block body start (after the begin marker line ending). */
  body_start: number;
  /** Offset of the block body end (start of the end marker line). */
  body_end: number;
  /** Offset of the end marker `<!--` (always equal to `body_end`). */
  end_start: number;
  /** Offset just past the end marker `-->` (before its line ending). */
  end_end: number;
}

/** Why managed-marker parsing failed; all values are fixed and redacted. */
export type ManagedBlocksError =
  | "malformed_marker"
  | "nested"
  | "orphan_end"
  | "mismatched"
  | "unclosed"
  | "duplicate";

/** Outcome of scanning the managed markers of a note. */
export type ManagedBlocksResult =
  | { kind: "ok"; blocks: ManagedBlock[] }
  | { kind: "malformed"; reason: ManagedBlocksError };

/** The complete position-aware model of one note. */
export interface ParsedNote {
  /** The exact original source; never normalized or rewritten. */
  source: string;
  /** Document line-ending style, preserved through every write. */
  line_ending: "\n" | "\r\n";
  frontmatter: FrontmatterResult;
  headings: HeadingOccurrence[];
  wikilinks: Wikilink[];
  managed: ManagedBlocksResult;
}

/** Fixed external message for marker-like text rejection. */
export const MARKER_TEXT_REJECTED_MESSAGE =
  "managed body contains marker-like text; rejected";

/** Heading lookup by full heading text (`## Tareas`). */
export type HeadingLookupResult =
  | { kind: "found"; heading: HeadingOccurrence }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number }
  | { kind: "invalid_heading" };

/** Section extraction by full heading text (`## Tareas`). */
export interface SectionExtraction {
  /** Offset of the section heading marker start. */
  heading_start: number;
  /** Offset of the section body start (after the heading line ending). */
  body_start: number;
  /** Offset of the next same-or-higher heading, or end of source. */
  section_end: number;
  /** Exact section body bytes: source.slice(body_start, section_end). */
  body: string;
}

/** Outcome of extracting one selected section. */
export type SectionLookupResult =
  | { kind: "found"; section: SectionExtraction }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number }
  | { kind: "invalid_heading" };

/** Outcome of replacing one managed block body. */
export type ManagedReplaceResult =
  | { kind: "replaced"; source: string; block: ManagedBlock }
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | { kind: "malformed"; reason: ManagedBlocksError }
  | { kind: "invalid_id" }
  | { kind: "marker_text_rejected"; message: typeof MARKER_TEXT_REJECTED_MESSAGE };

/** Outcome of inserting one managed block under a configured heading. */
export type ManagedInsertResult =
  | { kind: "inserted"; source: string; block: ManagedBlock }
  | { kind: "heading_missing" }
  | { kind: "heading_ambiguous"; count: number }
  | { kind: "block_exists" }
  | { kind: "malformed"; reason: ManagedBlocksError }
  | { kind: "invalid_id" }
  | { kind: "invalid_heading" }
  | { kind: "marker_text_rejected"; message: typeof MARKER_TEXT_REJECTED_MESSAGE };

// ---------------------------------------------------------------------------
// Line machinery
// ---------------------------------------------------------------------------

/** One source line: content without the line ending plus exact offsets. */
interface LineInfo {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the last non-line-ending character. */
  contentEnd: number;
  /** Offset just past the line ending (start of the next line, or EOF). */
  end: number;
  /** Line content without the line ending. */
  text: string;
}

/** Split source into lines with exact offsets; handles LF and CRLF. */
function lineInfos(source: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const start = i;
    let j = i;
    while (j < n && source[j] !== "\n" && source[j] !== "\r") {
      j += 1;
    }
    const contentEnd = j;
    const text = source.slice(i, j);
    let end: number;
    if (j < n && source[j] === "\r" && source[j + 1] === "\n") {
      end = j + 2;
    } else if (j < n && (source[j] === "\n" || source[j] === "\r")) {
      end = j + 1;
    } else {
      end = j;
    }
    lines.push({ start, contentEnd, end, text });
    i = end;
  }
  return lines;
}

/** Detect the document line-ending style from the first line ending. */
function detectLineEnding(source: string): "\n" | "\r\n" {
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") {
      return source[i - 1] === "\r" ? "\r\n" : "\n";
    }
    if (ch === "\r") {
      return source[i + 1] === "\n" ? "\r\n" : "\n";
    }
  }
  return "\n";
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Parse and narrow the leading YAML frontmatter block of a note. */
export function parseFrontmatter(source: string): FrontmatterResult {
  const lines = lineInfos(source);
  const first = lines[0];
  if (!first || first.text !== "---") {
    return { kind: "missing" };
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && line.text === "---") {
      closeIndex = i;
      break;
    }
  }
  // An opening `---` with no closing delimiter is a thematic break.
  if (closeIndex === -1) {
    return { kind: "missing" };
  }
  const closeLine = lines[closeIndex];
  if (!closeLine) {
    return { kind: "missing" };
  }
  const bodyStart = first.end;
  const bodyEnd = closeLine.start;
  const end = closeLine.end;
  let raw: unknown;
  try {
    raw = parseYaml(source.slice(bodyStart, bodyEnd), { maxAliasCount: 100 });
  } catch {
    return { kind: "invalid" };
  }
  return {
    kind: "present",
    metadata: narrowMetadata(raw),
    start: 0,
    end,
    body_start: bodyStart,
    body_end: bodyEnd,
  };
}

/** Narrow an unknown YAML document to the five allowed metadata fields. */
function narrowMetadata(raw: unknown): NoteMetadata {
  const metadata: NoteMetadata = {
    title: null,
    date: null,
    tags: [],
    aliases: [],
    resyst_project: null,
  };
  if (typeof raw !== "object" || raw === null) {
    return metadata;
  }
  const record = raw as Record<string, unknown>;
  const title = record["title"];
  if (typeof title === "string") {
    metadata.title = title;
  }
  const date = record["date"];
  if (typeof date === "string") {
    metadata.date = date;
  }
  metadata.tags = narrowStringList(record["tags"]);
  metadata.aliases = narrowStringList(record["aliases"]);
  const project = record["resyst_project"];
  if (typeof project === "string") {
    metadata.resyst_project = project;
  }
  return metadata;
}

/** Narrow a tags/aliases value: a single string or an array of strings. */
function narrowStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heading, fence, and managed-marker scanning
// ---------------------------------------------------------------------------

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Any bridge-owned marker-like token: `<!-- resyst-vault:...`. */
const MARKER_LIKE = /<!--\s*resyst-vault:/;
const BEGIN_MARKER =
  /^<!--\s*resyst-vault:begin\s+session=([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+target=([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*-->$/;
const END_MARKER =
  /^<!--\s*resyst-vault:end\s+session=([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+target=([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*-->$/;

/** Build the closing-fence matcher for an open fence char and length. */
function closingFence(char: string, length: number): RegExp {
  return new RegExp(`^ {0,3}${char}{${length},}[ \\t]*$`);
}

/** Region of one fenced code block, for skip checks of other scanners. */
interface FenceRegion {
  start: number;
  end: number;
}

/** Result of the single line-oriented scan pass. */
interface DocumentScan {
  headings: HeadingOccurrence[];
  fences: FenceRegion[];
  managed: ManagedBlocksResult;
}

/**
 * One line-oriented pass over the document producing headings (ATX and
 * setext), fenced-code regions, and the managed-marker result. Heading and
 * marker detection ignore fenced code blocks (backtick and tilde variants)
 * and the frontmatter block.
 */
function scanDocument(
  source: string,
  lines: LineInfo[],
  frontmatter: { start: number; end: number } | null,
): DocumentScan {
  const headings: HeadingOccurrence[] = [];
  const fences: FenceRegion[] = [];
  const completed: ManagedBlock[] = [];
  const open: ManagedBlock[] = [];
  let error: ManagedBlocksError | null = null;
  let inFence: { char: string; length: number; start: number } | null = null;
  let prevKind: "blank" | "paragraph" | "heading" | "fence" | "other" =
    "other";
  let prevParagraph: { text: string; start: number; contentEnd: number } | null =
    null;

  for (const line of lines) {
    if (
      frontmatter &&
      line.start >= frontmatter.start &&
      line.end <= frontmatter.end
    ) {
      prevKind = "other";
      prevParagraph = null;
      continue;
    }
    const text = line.text;

    if (inFence) {
      if (closingFence(inFence.char, inFence.length).test(text)) {
        fences.push({ start: inFence.start, end: line.end });
        inFence = null;
      }
      prevKind = "fence";
      prevParagraph = null;
      continue;
    }

    const fenceOpen = FENCE_OPEN.exec(text);
    if (fenceOpen) {
      const marker = fenceOpen[1] ?? "";
      inFence = {
        char: marker[0] ?? "`",
        length: marker.length,
        start: line.start,
      };
      prevKind = "fence";
      prevParagraph = null;
      continue;
    }

    if (text.trim() === "") {
      prevKind = "blank";
      prevParagraph = null;
      continue;
    }

    if (MARKER_LIKE.test(text)) {
      if (error === null) {
        const begin = BEGIN_MARKER.exec(text);
        const end = END_MARKER.exec(text);
        if (begin) {
          if (open.length > 0) {
            error = "nested";
          } else {
            open.push({
              session_id: begin[1] ?? "",
              target: begin[2] ?? "",
              begin_start: line.start,
              begin_end: line.contentEnd,
              body_start: line.end,
              body_end: 0,
              end_start: 0,
              end_end: 0,
            });
          }
        } else if (end) {
          const top = open.pop();
          if (!top) {
            error = "orphan_end";
          } else if (
            top.session_id !== (end[1] ?? "") ||
            top.target !== (end[2] ?? "")
          ) {
            error = "mismatched";
          } else {
            top.body_end = line.start;
            top.end_start = line.start;
            top.end_end = line.contentEnd;
            completed.push(top);
          }
        } else {
          error = "malformed_marker";
        }
      }
      prevKind = "other";
      prevParagraph = null;
      continue;
    }

    const atx = ATX_HEADING.exec(text);
    if (atx) {
      const level = (atx[1] ?? "").length;
      let rest = atx[2] ?? "";
      rest = rest.replace(/[ \t]+#+$/, "").replace(/[ \t]+$/, "");
      const headingText = rest.trim();
      const end = line.start + text.indexOf(rest) + rest.length;
      headings.push({
        text: headingText,
        level,
        start: line.start,
        end,
        line_end: line.end,
      });
      prevKind = "heading";
      prevParagraph = null;
      continue;
    }

    const setext = SETEXT_UNDERLINE.exec(text);
    if (setext) {
      if (prevKind === "paragraph" && prevParagraph) {
        const marker = setext[1] ?? "=";
        const level = marker.startsWith("=") ? 1 : 2;
        headings.push({
          text: prevParagraph.text,
          level,
          start: prevParagraph.start,
          end: prevParagraph.contentEnd,
          line_end: line.end,
        });
        prevKind = "heading";
        prevParagraph = null;
      } else {
        prevKind = "other";
        prevParagraph = null;
      }
      continue;
    }

    prevKind = "paragraph";
    prevParagraph = {
      text: text.trim(),
      start: line.start,
      contentEnd: line.start + text.trimEnd().length,
    };
  }

  if (inFence) {
    fences.push({ start: inFence.start, end: source.length });
  }

  let managed: ManagedBlocksResult;
  if (error !== null) {
    managed = { kind: "malformed", reason: error };
  } else if (open.length > 0) {
    managed = { kind: "malformed", reason: "unclosed" };
  } else {
    const seen = new Set<string>();
    let duplicate = false;
    for (const block of completed) {
      const key = `${block.session_id}\u0000${block.target}`;
      if (seen.has(key)) {
        duplicate = true;
        break;
      }
      seen.add(key);
    }
    managed = duplicate
      ? { kind: "malformed", reason: "duplicate" }
      : { kind: "ok", blocks: completed };
  }

  return { headings, fences, managed };
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/** Parse the inner text of a closed `[[...]]` into a link, or null. */
function parseWikilink(
  inner: string,
  start: number,
  end: number,
): Wikilink | null {
  if (inner === "") {
    return null;
  }
  let targetPart = inner;
  let alias: string | null = null;
  const pipe = inner.lastIndexOf("|");
  if (pipe >= 0) {
    const aliasText = inner.slice(pipe + 1).trim();
    alias = aliasText === "" ? null : aliasText;
    targetPart = inner.slice(0, pipe);
  }
  let anchor: string | null = null;
  let target: string | null = null;
  const hash = targetPart.indexOf("#");
  if (hash >= 0) {
    const anchorText = targetPart.slice(hash + 1).trim();
    anchor = anchorText === "" ? null : anchorText;
    const targetText = targetPart.slice(0, hash).trim();
    target = targetText === "" ? null : targetText;
  } else {
    const targetText = targetPart.trim();
    target = targetText === "" ? null : targetText;
  }
  if (target === null && anchor === null) {
    return null;
  }
  return { target, alias, anchor, start, end };
}

/**
 * Scan for well-formed `[[...]]` wikilinks, ignoring fenced code regions
 * and the frontmatter block. Unclosed or empty links are skipped.
 */
function scanWikilinks(
  source: string,
  regions: Array<{ start: number; end: number }>,
): Wikilink[] {
  const links: Wikilink[] = [];
  const n = source.length;
  let i = 0;
  while (i < n - 1) {
    const region = regions.find((r) => r.start <= i && i < r.end);
    if (region) {
      i = region.end;
      continue;
    }
    if (source[i] === "[" && source[i + 1] === "[") {
      let depth = 1;
      let j = i + 2;
      let closed = false;
      while (j < n - 1) {
        if (source[j] === "[" && source[j + 1] === "[") {
          depth += 1;
          j += 2;
        } else if (source[j] === "]" && source[j + 1] === "]") {
          depth -= 1;
          j += 2;
          if (depth === 0) {
            closed = true;
            break;
          }
        } else {
          j += 1;
        }
      }
      if (closed) {
        const inner = source.slice(i + 2, j - 2);
        const link = parseWikilink(inner, i, j);
        if (link) {
          links.push(link);
        }
        i = j;
      } else {
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return links;
}

// ---------------------------------------------------------------------------
// Public parse entry point
// ---------------------------------------------------------------------------

/** Parse a note into the position-aware model without modifying it. */
export function parseNote(source: string): ParsedNote {
  const lineEnding = detectLineEnding(source);
  const lines = lineInfos(source);
  const frontmatter = parseFrontmatter(source);
  const frontmatterRegion =
    frontmatter.kind === "present"
      ? { start: frontmatter.start, end: frontmatter.end }
      : null;
  const scan = scanDocument(source, lines, frontmatterRegion);
  const regions: Array<{ start: number; end: number }> = [
    ...scan.fences,
    ...(frontmatterRegion ? [frontmatterRegion] : []),
  ];
  const wikilinks = scanWikilinks(source, regions);
  return {
    source,
    line_ending: lineEnding,
    frontmatter,
    headings: scan.headings,
    wikilinks,
    managed: scan.managed,
  };
}

// ---------------------------------------------------------------------------
// Heading lookup and section extraction
// ---------------------------------------------------------------------------

/** Parse a caller-supplied heading string like `## Tareas`. */
function parseHeadingSpec(
  heading: string,
): { level: number; text: string } | null {
  const match = /^(#{1,6})[ \t]+(.+)$/.exec(heading);
  if (!match) {
    return null;
  }
  return { level: (match[1] ?? "").length, text: (match[2] ?? "").trim() };
}

/** Filter parsed headings to those matching a heading spec. */
function matchingHeadings(
  note: ParsedNote,
  spec: { level: number; text: string },
): HeadingOccurrence[] {
  return note.headings.filter(
    (heading) => heading.level === spec.level && heading.text === spec.text,
  );
}

/** Look up a heading by full heading text (`## Tareas`). */
export function findHeading(source: string, heading: string): HeadingLookupResult {
  const spec = parseHeadingSpec(heading);
  if (!spec) {
    return { kind: "invalid_heading" };
  }
  const matches = matchingHeadings(parseNote(source), spec);
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", count: matches.length };
  }
  return { kind: "found", heading: matches[0]! };
}

/**
 * Extract one selected section as exact source offsets and bytes. The
 * section body runs from just after the heading line to the next heading
 * of the same or higher level (or end of source).
 */
export function extractSection(
  source: string,
  heading: string,
): SectionLookupResult {
  const spec = parseHeadingSpec(heading);
  if (!spec) {
    return { kind: "invalid_heading" };
  }
  const note = parseNote(source);
  const matches = matchingHeadings(note, spec);
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", count: matches.length };
  }
  const selected = matches[0];
  if (!selected) {
    return { kind: "missing" };
  }
  let sectionEnd = source.length;
  for (const other of note.headings) {
    if (other.start > selected.start && other.level <= selected.level) {
      sectionEnd = other.start;
      break;
    }
  }
  return {
    kind: "found",
    section: {
      heading_start: selected.start,
      body_start: selected.line_end,
      section_end: sectionEnd,
      body: source.slice(selected.line_end, sectionEnd),
    },
  };
}

// ---------------------------------------------------------------------------
// Managed write operations
// ---------------------------------------------------------------------------

const ID_RE = new RegExp(`^${ID_PATTERN}$`);

/** Validate an opaque session/target id against the shared ID pattern. */
function isSafeId(value: string): boolean {
  return ID_RE.test(value);
}

/** True when a body could forge a bridge-owned marker. */
function containsMarkerLikeText(text: string): boolean {
  return MARKER_LIKE.test(text);
}

/** Normalize a body to the document line ending and one trailing break. */
function normalizeBody(body: string, eol: "\n" | "\r\n"): string {
  let normalized = body;
  if (eol === "\r\n") {
    normalized = normalized.replace(/(?<!\r)\n/g, "\r\n");
  }
  if (!normalized.endsWith(eol)) {
    normalized += eol;
  }
  return normalized;
}

/**
 * Replace the body of the single managed block matching session/target.
 * Only the bounded body region may change; prefix and suffix (including
 * CRLF endings) stay byte-identical. Missing or duplicate blocks fail
 * closed with typed results.
 */
export function replaceManagedBlock(
  source: string,
  sessionId: string,
  target: string,
  body: string,
): ManagedReplaceResult {
  if (!isSafeId(sessionId) || !isSafeId(target)) {
    return { kind: "invalid_id" };
  }
  if (containsMarkerLikeText(body)) {
    return {
      kind: "marker_text_rejected",
      message: MARKER_TEXT_REJECTED_MESSAGE,
    };
  }
  const note = parseNote(source);
  if (note.managed.kind === "malformed") {
    return { kind: "malformed", reason: note.managed.reason };
  }
  const matches = note.managed.blocks.filter(
    (block) => block.session_id === sessionId && block.target === target,
  );
  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous" };
  }
  const block = matches[0];
  if (!block) {
    return { kind: "not_found" };
  }
  const next =
    source.slice(0, block.body_start) +
    normalizeBody(body, note.line_ending) +
    source.slice(block.body_end);
  return { kind: "replaced", source: next, block };
}

/**
 * Insert a new managed block under exactly one configured heading. The
 * block is placed directly after the heading line; a missing heading, a
 * duplicate heading, or an already-existing session/target block all fail
 * closed with typed results instead of guessing a placement.
 */
export function insertManagedBlock(
  source: string,
  heading: string,
  sessionId: string,
  target: string,
  body: string,
): ManagedInsertResult {
  if (!isSafeId(sessionId) || !isSafeId(target)) {
    return { kind: "invalid_id" };
  }
  if (containsMarkerLikeText(body)) {
    return {
      kind: "marker_text_rejected",
      message: MARKER_TEXT_REJECTED_MESSAGE,
    };
  }
  const spec = parseHeadingSpec(heading);
  if (!spec) {
    return { kind: "invalid_heading" };
  }
  const note = parseNote(source);
  if (note.managed.kind === "malformed") {
    return { kind: "malformed", reason: note.managed.reason };
  }
  const exists = note.managed.blocks.some(
    (block) => block.session_id === sessionId && block.target === target,
  );
  if (exists) {
    return { kind: "block_exists" };
  }
  const matches = matchingHeadings(note, spec);
  if (matches.length === 0) {
    return { kind: "heading_missing" };
  }
  if (matches.length > 1) {
    return { kind: "heading_ambiguous", count: matches.length };
  }
  const selected = matches[0];
  if (!selected) {
    return { kind: "heading_missing" };
  }
  const eol = note.line_ending;
  const normalized = normalizeBody(body, eol);
  const beginMarker = `<!-- resyst-vault:begin session=${sessionId} target=${target} -->`;
  const endMarker = `<!-- resyst-vault:end session=${sessionId} target=${target} -->`;
  const blockText = `${beginMarker}${eol}${normalized}${endMarker}${eol}`;
  const next =
    source.slice(0, selected.line_end) +
    eol +
    blockText +
    source.slice(selected.line_end);
  const beginStart = selected.line_end + eol.length;
  const block: ManagedBlock = {
    session_id: sessionId,
    target,
    begin_start: beginStart,
    begin_end: beginStart + beginMarker.length,
    body_start: beginStart + beginMarker.length + eol.length,
    body_end:
      beginStart + beginMarker.length + eol.length + normalized.length,
    end_start: beginStart + beginMarker.length + eol.length + normalized.length,
    end_end:
      beginStart +
      beginMarker.length +
      eol.length +
      normalized.length +
      endMarker.length,
  };
  return { kind: "inserted", source: next, block };
}
