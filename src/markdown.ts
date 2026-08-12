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

/** Maximum length of one narrowed frontmatter string value. */
export const MAX_FRONTMATTER_STRING_LENGTH = 1024;

/** Maximum number of items in one narrowed frontmatter list value. */
export const MAX_FRONTMATTER_LIST_LENGTH = 64;

/**
 * Narrowed portable project metadata from the `resyst_project` frontmatter
 * object: a required safe `id` plus exact output `repos`/`aliases` arrays
 * (missing or empty input arrays normalize to `[]`). Unknown nested keys
 * are never copied.
 */
export interface ResystProjectMetadata {
  /** Safe opaque project id matching the shared ID pattern. */
  id: string;
  /** Bounded repository strings. */
  repos: string[];
  /** Bounded alias strings. */
  aliases: string[];
}

/** Narrowed frontmatter metadata: only the five allowed fields survive. */
export interface NoteMetadata {
  title: string | null;
  date: string | null;
  tags: string[];
  aliases: string[];
  /** Null when absent or when the portable object is malformed. */
  resyst_project: ResystProjectMetadata | null;
}

/**
 * Frontmatter parse outcome. `present` carries the exact source offsets of
 * the whole `---`-delimited block (start at offset 0, end after the closing
 * delimiter's line ending) plus the body range.
 */
export type FrontmatterResult =
  | { kind: "missing" }
  | {
      /** Delimited frontmatter whose YAML body failed to parse. */
      kind: "invalid";
      start: number;
      end: number;
      body_start: number;
      body_end: number;
    }
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
  line_ending: "\n" | "\r\n" | "\r";
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
  | { kind: "invalid_frontmatter" }
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
  | { kind: "invalid_frontmatter" }
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
function detectLineEnding(source: string): "\n" | "\r\n" | "\r" {
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") {
      return source[i - 1] === "\r" ? "\r\n" : "\n";
    }
    if (ch === "\r") {
      return source[i + 1] === "\n" ? "\r\n" : "\r";
    }
  }
  return "\n";
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Locate a leading `---`-delimited frontmatter block, independent of YAML
 * validity. A leading `---` with no closing delimiter is a thematic break,
 * not a frontmatter block (intentional policy: such documents are scanned
 * normally).
 */
function findFrontmatterRegion(
  lines: LineInfo[],
): { start: number; end: number; body_start: number; body_end: number } | null {
  const first = lines[0];
  if (!first || first.text !== "---") {
    return null;
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && line.text === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return null;
  }
  const closeLine = lines[closeIndex];
  if (!closeLine) {
    return null;
  }
  return {
    start: 0,
    end: closeLine.end,
    body_start: first.end,
    body_end: closeLine.start,
  };
}

/** Parse and narrow the leading YAML frontmatter block of a note. */
export function parseFrontmatter(source: string): FrontmatterResult {
  const lines = lineInfos(source);
  const region = findFrontmatterRegion(lines);
  if (!region) {
    return { kind: "missing" };
  }
  let raw: unknown;
  try {
    raw = parseYaml(source.slice(region.body_start, region.body_end), {
      maxAliasCount: 100,
    });
  } catch {
    return {
      kind: "invalid",
      start: region.start,
      end: region.end,
      body_start: region.body_start,
      body_end: region.body_end,
    };
  }
  return {
    kind: "present",
    metadata: narrowMetadata(raw),
    start: region.start,
    end: region.end,
    body_start: region.body_start,
    body_end: region.body_end,
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
  metadata.resyst_project = narrowProject(record["resyst_project"]);
  return metadata;
}

/**
 * Narrow the portable `resyst_project` object. The value is null (absent)
 * for legacy notes; when present it must be an object with a required safe
 * `id`, and `repos`/`aliases` are optional input arrays that normalize to
 * required output arrays (missing -> `[]`). Any present array that is not
 * an array of bounded nonempty strings rejects the entire value to null;
 * partial malformed metadata is never retained and unknown keys are never
 * copied.
 */
function narrowProject(value: unknown): ResystProjectMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return null;
  }
  const repos = narrowRequiredStringArray(record["repos"]);
  if (repos === null) {
    return null;
  }
  const aliases = narrowRequiredStringArray(record["aliases"]);
  if (aliases === null) {
    return null;
  }
  return { id, repos, aliases };
}

/** Narrow a required string array, or null when the contract is violated. */
function narrowRequiredStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_FRONTMATTER_LIST_LENGTH) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > MAX_FRONTMATTER_STRING_LENGTH
    ) {
      return null;
    }
    out.push(item);
  }
  return out;
}

/**
 * Narrow a note-level tags/aliases value: a single bounded string or a
 * bounded array of bounded strings (non-conforming items are dropped).
 */
function narrowStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length <= MAX_FRONTMATTER_STRING_LENGTH ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      item.length > 0 &&
      item.length <= MAX_FRONTMATTER_STRING_LENGTH
    ) {
      out.push(item);
      if (out.length >= MAX_FRONTMATTER_LIST_LENGTH) {
        break;
      }
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
  /** Fenced code regions (backtick and tilde variants). */
  fences: FenceRegion[];
  /** 4+-column indented code lines, excluded from all scanners. */
  indented: FenceRegion[];
  managed: ManagedBlocksResult;
}

/** True for lines indented 4+ columns (spaces or tabs = 4 columns). */
function isIndentedCode(text: string): boolean {
  let columns = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === " ") {
      columns += 1;
    } else if (ch === "\t") {
      columns += 4;
    } else {
      break;
    }
    if (columns >= 4) {
      return true;
    }
  }
  return false;
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
  const indented: FenceRegion[] = [];
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
      const info = fenceOpen[2] ?? "";
      // CommonMark: a backtick fence whose info string contains a backtick
      // is not a fence (the line is a paragraph); tilde info strings may
      // contain backticks.
      if (marker.startsWith("~") || !info.includes("`")) {
        inFence = {
          char: marker[0] ?? "`",
          length: marker.length,
          start: line.start,
        };
        prevKind = "fence";
        prevParagraph = null;
        continue;
      }
      // fall through: the line is a paragraph, not a fence opener
    }

    if (text.trim() === "") {
      prevKind = "blank";
      prevParagraph = null;
      continue;
    }

    if (isIndentedCode(text)) {
      indented.push({ start: line.start, end: line.end });
      prevKind = "other";
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

  return { headings, fences, indented, managed };
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/**
 * Parse the inner text of a closed `[[...]]` into a link, or null.
 * Nested `[[`, marker-like brackets (`<!--`/`-->`), and empty targets are
 * malformed and produce no link. Line breaks cannot occur (candidates are
 * bounded to one line by the scanner).
 */
function parseWikilink(
  inner: string,
  start: number,
  end: number,
): Wikilink | null {
  if (
    inner === "" ||
    inner.includes("[[") ||
    inner.includes("<!--") ||
    inner.includes("-->")
  ) {
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
 * Compute inline-code spans of one line. A backtick run opens a span; the
 * next run of the same length closes it (runs of other lengths are literal
 * content inside the span). An unmatched opening run is literal text, so no
 * region is produced. Single linear pass per line.
 */
function inlineCodeRegions(text: string, base: number): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  const len = text.length;
  let openRun = -1;
  let openPos = -1;
  let i = 0;
  while (i < len) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < len && text[i + run] === "`") {
      run += 1;
    }
    if (openRun === -1) {
      openRun = run;
      openPos = i;
    } else if (run === openRun) {
      regions.push({ start: base + openPos, end: base + i + run });
      openRun = -1;
      openPos = -1;
    }
    i += run;
  }
  return regions;
}

/**
 * Scan one non-excluded line for well-formed `[[...]]` wikilinks, skipping
 * inline-code spans. The closer search never crosses the line, never enters
 * an inline-code span, and stops at a nested `[[` (rejecting the outer
 * link). A per-line `noCloserAfter` cache keeps the pass linear even when a
 * line holds thousands of unclosed openers.
 */
function scanLineLinks(
  text: string,
  base: number,
  codeRegions: Array<{ start: number; end: number }>,
): Wikilink[] {
  const links: Wikilink[] = [];
  const len = text.length;
  let regionIdx = 0;
  let noCloserAfter = -1;
  let i = 0;
  while (i < len - 1) {
    while (regionIdx < codeRegions.length && codeRegions[regionIdx]!.end <= i) {
      regionIdx += 1;
    }
    const codeRegion = codeRegions[regionIdx];
    if (codeRegion && i >= codeRegion.start) {
      i = codeRegion.end;
      continue;
    }
    if (text[i] === "[" && text[i + 1] === "[") {
      if (noCloserAfter >= 0 && i >= noCloserAfter) {
        i += 2;
        continue;
      }
      let j = i + 2;
      let codeIdx = regionIdx;
      let closed = false;
      while (j < len - 1) {
        while (codeIdx < codeRegions.length && codeRegions[codeIdx]!.end <= j) {
          codeIdx += 1;
        }
        const span = codeRegions[codeIdx];
        if (span && j >= span.start) {
          j = span.end;
          continue;
        }
        if (text[j] === "[" && text[j + 1] === "[") {
          break;
        }
        if (text[j] === "]" && text[j + 1] === "]") {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        const link = parseWikilink(text.slice(i + 2, j), base + i, base + j + 2);
        if (link) {
          links.push(link);
        }
        i = j + 2;
        continue;
      }
      if (j >= len - 1) {
        noCloserAfter = i;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return links;
}

/**
 * Scan for well-formed `[[...]]` wikilinks with bounded monotonic logic:
 * excluded whole-line regions (frontmatter, fences, indented code) are
 * skipped with a cursor, inline-code spans per line are excluded, and each
 * candidate is bounded to its own line. Unclosed, nested, and
 * marker-bracket-carrying candidates are malformed and never emitted.
 */
function scanWikilinks(
  lines: LineInfo[],
  excluded: Array<{ start: number; end: number }>,
): Wikilink[] {
  const links: Wikilink[] = [];
  let regionIdx = 0;
  for (const line of lines) {
    while (regionIdx < excluded.length && excluded[regionIdx]!.end <= line.start) {
      regionIdx += 1;
    }
    const excludedRegion = excluded[regionIdx];
    if (
      excludedRegion &&
      excludedRegion.start <= line.start &&
      line.end <= excludedRegion.end
    ) {
      continue;
    }
    links.push(...scanLineLinks(line.text, line.start, inlineCodeRegions(line.text, line.start)));
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
  // Delimiter-region detection is independent of YAML validity: a found
  // leading `---` block is excluded from headings, wikilinks, fences, and
  // managed markers even when its YAML body fails to parse.
  const frontmatterRegion = findFrontmatterRegion(lines);
  const scan = scanDocument(source, lines, frontmatterRegion);
  const excluded: Array<{ start: number; end: number }> = [
    ...scan.fences,
    ...scan.indented,
    ...(frontmatterRegion ? [frontmatterRegion] : []),
  ];
  const wikilinks = scanWikilinks(lines, excluded);
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

/**
 * Normalize every input line ending (CRLF, lone CR, lone LF) to the
 * document's chosen style and ensure exactly one trailing break, so a
 * replacement/insertion body can never introduce mixed line endings.
 */
function normalizeBody(body: string, eol: "\n" | "\r\n" | "\r"): string {
  const normalized = body.replace(/\r\n|\r|\n/g, eol);
  return normalized.endsWith(eol) ? normalized : `${normalized}${eol}`;
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
  if (note.frontmatter.kind === "invalid") {
    return { kind: "invalid_frontmatter" };
  }
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
  const normalized = normalizeBody(body, note.line_ending);
  const next =
    source.slice(0, block.body_start) +
    normalized +
    source.slice(block.body_end);
  // Return the block recomputed against the NEW source: the body offsets
  // shift when the replacement body length differs from the original.
  const endMarkerLength = block.end_end - block.end_start;
  const newBodyEnd = block.body_start + normalized.length;
  const updated: ManagedBlock = {
    session_id: sessionId,
    target,
    begin_start: block.begin_start,
    begin_end: block.begin_end,
    body_start: block.body_start,
    body_end: newBodyEnd,
    end_start: newBodyEnd,
    end_end: newBodyEnd + endMarkerLength,
  };
  return { kind: "replaced", source: next, block: updated };
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
  if (note.frontmatter.kind === "invalid") {
    return { kind: "invalid_frontmatter" };
  }
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
