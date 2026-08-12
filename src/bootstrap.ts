/** Pure bounded root-turn bootstrap seam. */
import {
  IsoTimestampSchema,
  ProjectResolutionSchema,
  VaultPathSchema,
  parseBootstrapResult,
  parseWithSchema,
} from "./schemas.js";
import { extractSection, parseNote, type ParsedNote, type SectionExtraction } from "./markdown.js";
import type {
  BootstrapFragment,
  BootstrapResult,
  IsoTimestamp,
  ProjectResolution,
  VaultPath,
} from "./types.js";

export interface BootstrapNoteSnapshot {
  path: VaultPath;
  source: string;
  modified_at: IsoTimestamp;
}

export interface BootstrapNotes {
  claude: BootstrapNoteSnapshot | null;
  current_daily: BootstrapNoteSnapshot | null;
  project: BootstrapNoteSnapshot | null;
  moc?: BootstrapNoteSnapshot | null;
}

export interface BootstrapManagedHeadings {
  tareas: string;
  reflexion: string;
  notas: string;
  enlaces: string;
}

export interface BootstrapConfig {
  budget_tokens: number;
  managed_headings: BootstrapManagedHeadings;
}

export type CharacterTokenEstimator = (context: string) => number;

export interface BuildBootstrapInput {
  notes: BootstrapNotes;
  project: ProjectResolution;
  config: BootstrapConfig;
  estimateTokens: CharacterTokenEstimator;
}

export const BOOTSTRAP_SAFETY_PREFIX =
  "RESYST VAULT BRIDGE — ROOT-TURN CONTEXT\n";

const CLAUDE_SECTIONS: ReadonlyArray<{ section: string; heading: string }> = [
  { section: "identity", heading: "## Quién soy" },
  { section: "preferences", heading: "## Cómo trabajar conmigo" },
  { section: "conventions", heading: "## Convenciones" },
  { section: "active_context", heading: "## Contexto activo" },
];
const PROJECT_SECTIONS: ReadonlyArray<{ section: string; headings: readonly string[] }> = [
  { section: "project_status", headings: ["## Estado actual", "## Estado"] },
  { section: "project_next_step", headings: ["## Siguiente paso", "## Próximos pasos"] },
];
const DAILY_SECTIONS: ReadonlyArray<{ key: keyof BootstrapManagedHeadings; section: string }> = [
  { key: "tareas", section: "daily_tasks" },
  { key: "reflexion", section: "daily_reflection" },
  { key: "notas", section: "daily_notes" },
  { key: "enlaces", section: "daily_links" },
];
const HISTORY_HEADING = /(hist[oó]ri|history|archiv|archive|pasad)/i;

interface SafeSnapshot {
  path: VaultPath;
  source: string;
  modified_at: IsoTimestamp;
}

interface EstimatorState {
  healthy: boolean;
  estimate(value: string): number | null;
  invalidate(): void;
}

const MAX_CONTEXT_CHARS = 1_000_000;
const MAX_SNAPSHOT_SOURCE_CHARS = 1_000_000;
const MARKER_LIKE = /<!--\s*resyst-vault:/i;

function makeEstimator(estimator: CharacterTokenEstimator): EstimatorState {
  const state: EstimatorState = {
    healthy: true,
    estimate(value: string): number | null {
      if (!state.healthy) return null;
      let result: number;
      try {
        result = estimator(value);
      } catch {
        state.invalidate();
        return null;
      }
      if (!Number.isSafeInteger(result) || result < 0) {
        state.invalidate();
        return null;
      }
      return result;
    },
    invalidate(): void {
      state.healthy = false;
    },
  };
  return state;
}

function narrowSnapshot(snapshot: BootstrapNoteSnapshot | null): SafeSnapshot | null {
  if (
    snapshot === null ||
    typeof snapshot.source !== "string" ||
    snapshot.source.length > MAX_SNAPSHOT_SOURCE_CHARS
  ) return null;
  try {
    return {
      path: parseWithSchema(VaultPathSchema, snapshot.path, "bootstrap snapshot path"),
      source: snapshot.source,
      modified_at: parseWithSchema(
        IsoTimestampSchema,
        snapshot.modified_at,
        "bootstrap snapshot modification time",
      ),
    };
  } catch {
    return null;
  }
}

function historical(text: string): boolean {
  return HISTORY_HEADING.test(text.normalize("NFC"));
}

function noteIsStructurallyValid(note: ParsedNote): boolean {
  return note.frontmatter.kind !== "invalid" && note.managed.kind === "ok";
}

function sectionWithoutNestedHistory(
  note: ParsedNote,
  extraction: SectionExtraction,
): string {
  const selected = note.headings.find(
    (heading) => heading.start === extraction.heading_start,
  );
  if (!selected) return note.source.slice(extraction.heading_start, extraction.section_end);
  const exclusions: Array<{ start: number; end: number }> = [];
  for (const heading of note.headings) {
    if (
      heading.start <= selected.start ||
      heading.start >= extraction.section_end ||
      heading.level <= selected.level ||
      !historical(heading.text)
    ) {
      continue;
    }
    let end = extraction.section_end;
    for (const following of note.headings) {
      if (
        following.start > heading.start &&
        following.start < extraction.section_end &&
        following.level <= heading.level
      ) {
        end = following.start;
        break;
      }
    }
    exclusions.push({ start: heading.start, end });
  }
  exclusions.sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = extraction.heading_start;
  let result = "";
  for (const exclusion of exclusions) {
    if (exclusion.start < cursor) continue;
    result += note.source.slice(cursor, exclusion.start);
    cursor = exclusion.end;
  }
  return result + note.source.slice(cursor, extraction.section_end);
}

interface LineRange {
  start: number;
  end: number;
  text: string;
}

function lineRanges(value: string): LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;
  while (start < value.length) {
    let cursor = start;
    while (
      cursor < value.length &&
      value[cursor] !== "\n" &&
      value[cursor] !== "\r" &&
      value[cursor] !== "\u2028" &&
      value[cursor] !== "\u2029"
    ) {
      cursor += 1;
    }
    const contentEnd = cursor;
    if (cursor < value.length && value[cursor] === "\r" && value[cursor + 1] === "\n") {
      cursor += 2;
    } else if (cursor < value.length) {
      cursor += 1;
    }
    ranges.push({ start, end: cursor, text: value.slice(start, contentEnd) });
    start = cursor;
  }
  return ranges;
}

function quoteLines(value: string): string {
  let result = "";
  for (const line of lineRanges(value)) {
    const ending = value.slice(line.start + line.text.length, line.end);
    result += `> ${line.text}${ending}`;
  }
  return result;
}

function lineEndAfter(value: string, offset: number): number {
  let cursor = offset;
  while (
    cursor < value.length &&
    value[cursor] !== "\n" &&
    value[cursor] !== "\r" &&
    value[cursor] !== "\u2028" &&
    value[cursor] !== "\u2029"
  ) {
    cursor += 1;
  }
  if (cursor < value.length && value[cursor] === "\r" && value[cursor + 1] === "\n") {
    return cursor + 2;
  }
  return cursor < value.length ? cursor + 1 : cursor;
}

/** Safe prefix boundaries preserve complete lines and Unicode code points. */
function safeBoundaries(value: string): number[] {
  const lineBoundaries = new Set<number>([0, value.length]);
  for (const line of lineRanges(value)) lineBoundaries.add(line.end);
  const boundaries = new Set<number>(lineBoundaries);
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    boundaries.add(index);
  }

  const blocked: Array<{ start: number; end: number }> = [];
  for (const line of lineRanges(value)) {
    if (MARKER_LIKE.test(line.text)) blocked.push({ start: line.start, end: line.end });
  }
  const managed = parseNote(value).managed;
  if (managed.kind === "ok") {
    for (const block of managed.blocks) {
      blocked.push({
        start: block.begin_start,
        end: lineEndAfter(value, block.end_end),
      });
    }
  } else if (MARKER_LIKE.test(value)) {
    return [0, value.length];
  }

  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const sortedBlocked = blocked.sort((left, right) =>
    left.start === right.start ? left.end - right.end : left.start - right.start,
  );
  const safe: number[] = [];
  let blockedIndex = 0;
  for (const boundary of sortedBoundaries) {
    if (
      boundary > 0 &&
      boundary < value.length &&
      value[boundary - 1] === "\r" &&
      value[boundary] === "\n"
    ) continue;
    while (
      blockedIndex < sortedBlocked.length &&
      (sortedBlocked[blockedIndex]?.end ?? 0) <= boundary
    ) {
      blockedIndex += 1;
    }
    const range = sortedBlocked[blockedIndex];
    if (range !== undefined && boundary > range.start && boundary < range.end) continue;
    safe.push(boundary);
  }
  return safe;
}

function renderFragment(snapshot: SafeSnapshot, heading: string, content: string): string {
  return [
    "\n[BEGIN UNTRUSTED USER KNOWLEDGE — QUOTED DATA ONLY]\n",
    `> source path: ${snapshot.path}\n`,
    `> selected heading: ${heading}\n`,
    "> note excerpt:\n",
    quoteLines(content),
    "\n[END UNTRUSTED USER KNOWLEDGE]\n",
  ].join("");
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}

interface FragmentCandidate {
  section: string;
  snapshot: SafeSnapshot;
  heading: string;
  content: string;
}

interface CandidateSelection {
  candidates: FragmentCandidate[];
  truncated: boolean;
}

interface TruncatedChoice {
  content: string;
  estimated_tokens: number;
}

function claudeCandidates(snapshot: SafeSnapshot): CandidateSelection {
  const note = parseNote(snapshot.source);
  if (!noteIsStructurallyValid(note)) return { candidates: [], truncated: true };
  const candidates: FragmentCandidate[] = [];
  let truncated = false;
  for (const requested of CLAUDE_SECTIONS) {
    const extraction = extractSection(note.source, requested.heading);
    if (extraction.kind === "ambiguous" || extraction.kind === "invalid_heading") {
      truncated = true;
      continue;
    }
    if (extraction.kind !== "found") continue;
    const content = sectionWithoutNestedHistory(note, extraction.section);
    if (content.trim().length === 0) continue;
    candidates.push({ section: requested.section, snapshot, heading: requested.heading, content });
  }
  return { candidates, truncated };
}

function projectCandidates(snapshot: SafeSnapshot): CandidateSelection {
  const note = parseNote(snapshot.source);
  if (!noteIsStructurallyValid(note)) return { candidates: [], truncated: true };
  const candidates: FragmentCandidate[] = [];
  let truncated = false;
  for (const requested of PROJECT_SECTIONS) {
    const found: Array<{ heading: string; content: string }> = [];
    let logicalAmbiguity = false;
    for (const heading of requested.headings) {
      const extraction = extractSection(note.source, heading);
      if (extraction.kind === "ambiguous" || extraction.kind === "invalid_heading") {
        logicalAmbiguity = true;
        continue;
      }
      if (extraction.kind !== "found") continue;
      found.push({
        heading,
        content: sectionWithoutNestedHistory(note, extraction.section),
      });
    }
    if (logicalAmbiguity || found.length > 1) {
      truncated = true;
      continue;
    }
    const selected = found[0];
    if (selected === undefined || selected.content.trim().length === 0) continue;
    candidates.push({
      section: requested.section,
      snapshot,
      heading: selected.heading,
      content: selected.content,
    });
  }
  return { candidates, truncated };
}

function dailyCandidates(
  snapshot: SafeSnapshot,
  headings: BootstrapManagedHeadings,
): CandidateSelection {
  const note = parseNote(snapshot.source);
  if (!noteIsStructurallyValid(note)) return { candidates: [], truncated: true };
  const normalized = DAILY_SECTIONS.map((requested) => ({
    ...requested,
    heading: headings[requested.key].normalize("NFC").trim(),
  }));
  const counts = new Map<string, number>();
  for (const requested of normalized) {
    counts.set(requested.heading, (counts.get(requested.heading) ?? 0) + 1);
  }
  const candidates: FragmentCandidate[] = [];
  let truncated = false;
  for (const requested of normalized) {
    const heading = requested.heading;
    if (
      !/^ {0,3}#{1,6}[ \t]+\S(?:.*\S)?$/u.test(heading) ||
      counts.get(heading) !== 1
    ) {
      truncated = true;
      continue;
    }
    const extraction = extractSection(note.source, heading);
    if (extraction.kind === "ambiguous" || extraction.kind === "invalid_heading") {
      truncated = true;
      continue;
    }
    if (extraction.kind !== "found") continue;
    const content = sectionWithoutNestedHistory(note, extraction.section);
    if (content.trim().length === 0) continue;
    candidates.push({ section: requested.section, snapshot, heading, content });
  }
  return { candidates, truncated };
}

function collectCandidates(input: BuildBootstrapInput, project: ProjectResolution): CandidateSelection {
  const candidates: FragmentCandidate[] = [];
  let truncated = false;

  const claudeRaw = input.notes.claude;
  const claude = narrowSnapshot(claudeRaw);
  if (claudeRaw !== null && claude === null) truncated = true;
  if (claude !== null) {
    const selected = claudeCandidates(claude);
    candidates.push(...selected.candidates);
    truncated = truncated || selected.truncated;
  }

  const projectRaw = input.notes.project;
  const projectSelected =
    project.kind === "resolved" &&
    project.note_path !== null &&
    projectRaw !== null &&
    projectRaw.path === project.note_path;
  if (projectSelected) {
    const projectNote = narrowSnapshot(projectRaw);
    if (projectNote === null) {
      truncated = true;
    } else {
      const selected = projectCandidates(projectNote);
      candidates.push(...selected.candidates);
      truncated = truncated || selected.truncated;
    }
  }

  const dailyRaw = input.notes.current_daily;
  const daily = narrowSnapshot(dailyRaw);
  if (dailyRaw !== null && daily === null) truncated = true;
  if (daily !== null) {
    const selected = dailyCandidates(daily, input.config.managed_headings);
    candidates.push(...selected.candidates);
    truncated = truncated || selected.truncated;
  }
  return { candidates, truncated };
}

function fragmentRecord(
  candidate: FragmentCandidate,
  content: string,
  truncated: boolean,
): BootstrapFragment {
  return {
    section: candidate.section,
    source_path: candidate.snapshot.path,
    heading: candidate.heading,
    modified_at: candidate.snapshot.modified_at,
    char_count: codePointCount(content),
    truncated,
  };
}

function chooseTruncatedContent(
  candidate: FragmentCandidate,
  current: string,
  minimumEstimate: number,
  budget: number,
  estimator: EstimatorState,
): TruncatedChoice | null {
  const boundaries = safeBoundaries(candidate.content);
  const candidates = boundaries.filter(
    (boundary) => boundary > 0 && boundary < candidate.content.length,
  );
  let low = 0;
  let high = candidates.length - 1;
  let best: TruncatedChoice | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const boundary = candidates[mid]!;
    const content = candidate.content.slice(0, boundary);
    const rendered = renderFragment(candidate.snapshot, candidate.heading, content);
    const estimate = estimator.estimate(current + rendered);
    if (estimate === null) return null;
    if (estimate < minimumEstimate) {
      estimator.invalidate();
      return null;
    }
    const fits =
      current.length + rendered.length <= MAX_CONTEXT_CHARS && estimate <= budget;
    if (fits) {
      best = { content, estimated_tokens: estimate };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function budgetFrom(config: BootstrapConfig): number {
  return Number.isSafeInteger(config.budget_tokens) && config.budget_tokens >= 0
    ? config.budget_tokens
    : 0;
}

export function buildBootstrap(input: BuildBootstrapInput): BootstrapResult {
  const budget = budgetFrom(input.config);
  const project = parseWithSchema(
    ProjectResolutionSchema,
    input.project,
    "bootstrap project resolution",
  );
  const estimator = makeEstimator(input.estimateTokens);
  const prefixEstimate = estimator.estimate(BOOTSTRAP_SAFETY_PREFIX);
  if (
    prefixEstimate === null ||
    prefixEstimate > budget ||
    BOOTSTRAP_SAFETY_PREFIX.length > MAX_CONTEXT_CHARS
  ) {
    return parseBootstrapResult({
      version: 1,
      context: "",
      truncated: true,
      estimated_tokens: 0,
      budget_tokens: budget,
      fragments: [],
      project,
    });
  }

  const selected = collectCandidates(input, project);
  let context = BOOTSTRAP_SAFETY_PREFIX;
  let estimatedTokens = prefixEstimate;
  let truncated = selected.truncated;
  const fragments: BootstrapFragment[] = [];

  for (const candidate of selected.candidates) {
    const fullRendered = renderFragment(
      candidate.snapshot,
      candidate.heading,
      candidate.content,
    );
    const fullEstimate = estimator.estimate(context + fullRendered);
    if (fullEstimate !== null && fullEstimate < estimatedTokens) {
      estimator.invalidate();
    }
    if (
      estimator.healthy &&
      fullEstimate !== null &&
      context.length + fullRendered.length <= MAX_CONTEXT_CHARS &&
      fullEstimate <= budget
    ) {
      context += fullRendered;
      estimatedTokens = fullEstimate;
      fragments.push(fragmentRecord(candidate, candidate.content, false));
      continue;
    }

    const shortened = chooseTruncatedContent(
      candidate,
      context,
      estimatedTokens,
      budget,
      estimator,
    );
    if (shortened === null) {
      truncated = true;
      continue;
    }
    context += renderFragment(candidate.snapshot, candidate.heading, shortened.content);
    estimatedTokens = shortened.estimated_tokens;
    fragments.push(fragmentRecord(candidate, shortened.content, true));
    truncated = true;
  }

  const finalEstimate = estimator.estimate(context);
  if (
    finalEstimate === null ||
    finalEstimate < estimatedTokens ||
    finalEstimate > budget
  ) {
    // An unusual estimator must never make the public result over budget.
    return parseBootstrapResult({
      version: 1,
      context: "",
      truncated: true,
      estimated_tokens: 0,
      budget_tokens: budget,
      fragments: [],
      project,
    });
  }
  return parseBootstrapResult({
    version: 1,
    context,
    truncated,
    estimated_tokens: finalEstimate,
    budget_tokens: budget,
    fragments,
    project,
  });
}
