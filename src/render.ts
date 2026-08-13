/** Pure deterministic managed-record planning for vault destinations. */
import { createHash } from "node:crypto";
import type { BridgeConfig } from "./config.js";
import {
  findHeading,
  insertManagedBlock,
  replaceManagedBlock,
} from "./markdown.js";
import { HashHexSchema, VaultPathSchema, parseWithSchema } from "./schemas.js";
import type {
  ApplyCheckpoint,
  HashHex,
  ProjectResolution,
  Targets,
  VaultPath,
} from "./types.js";

export const MAX_RENDER_SOURCE_CHARS = 1_000_000;

export type WritePlanReason =
  | "daily_create"
  | "daily_update"
  | "project_update"
  | "landscape_moc"
  | "landscape_claude"
  | "association_proposal";

export interface WritePlan {
  path: VaultPath;
  before_hash: HashHex | null;
  after_content: string;
  after_hash: HashHex;
  reason: WritePlanReason;
}

export type RenderPlanResult =
  | { kind: "plan"; plans: WritePlan[] }
  | { kind: "deferred"; reason: "conflict" | "landscape_ambiguous"; conflict_paths: VaultPath[] }
  | { kind: "nothing" };

export interface RenderSnapshots {
  daily: string | null;
  project: string | null;
  moc: string | null;
  claude: string | null;
}

export interface BuildWritePlansInput {
  checkpoint: ApplyCheckpoint;
  effective_targets: Targets;
  resolution: ProjectResolution;
  project_title: string | null;
  snapshots: RenderSnapshots;
  template_source: string | null;
  config: {
    daily_dir: BridgeConfig["layout"]["daily_dir"];
    managed_headings: BridgeConfig["managed_headings"];
  };
  date: string;
}

const DAILY_FRAGMENTS = [
  { key: "tareas", target: "daily-tareas" },
  { key: "reflexion", target: "daily-reflexion" },
  { key: "notas", target: "daily-notas" },
  { key: "enlaces", target: "daily-enlaces" },
] as const;

function hash(value: string): HashHex {
  return parseWithSchema(
    HashHexSchema,
    createHash("sha256").update(value, "utf8").digest("hex"),
    "content hash",
  );
}

function safeText(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replaceAll("<", "&lt;")
    .replace(/[\\`*_\[\]|]/gu, "\\$&");
}

function safeLinkTitle(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !/[\r\n\u2028\u2029[\]|#^\\]/u.test(value) &&
    !/<!--\s*resyst-vault:/iu.test(value)
  );
}

function evidenceMap(checkpoint: ApplyCheckpoint): Map<string, string> {
  const map = new Map<string, string>();
  for (const collection of Object.values(checkpoint.evidence)) {
    for (const item of collection) map.set(item.id, safeText(item.value));
  }
  return map;
}

function linesFor(
  items: ApplyCheckpoint["knowledge"]["completed_tasks"],
  evidence: Map<string, string>,
  prefix: string,
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`${prefix}${safeText(item.text)}`);
    for (const id of item.evidence) {
      const value = evidence.get(id);
      if (value !== undefined) lines.push(`  - evidencia: ${value}`);
    }
  }
  return lines;
}

function dailyBodies(
  input: BuildWritePlansInput,
): Record<(typeof DAILY_FRAGMENTS)[number]["key"], string> {
  const evidence = evidenceMap(input.checkpoint);
  return {
    tareas: [
      ...linesFor(input.checkpoint.knowledge.completed_tasks, evidence, "- [x] "),
      ...linesFor(input.checkpoint.knowledge.next_steps, evidence, "- [ ] "),
    ].join("\n"),
    reflexion: [
      ...linesFor(input.checkpoint.knowledge.status_changes, evidence, "- Estado: "),
      ...linesFor(input.checkpoint.knowledge.blockers, evidence, "- Bloqueo: "),
    ].join("\n"),
    notas: [
      ...linesFor(input.checkpoint.knowledge.decisions, evidence, "- Decisión: "),
      ...linesFor(input.checkpoint.knowledge.reusable_learnings, evidence, "- Aprendizaje: "),
    ].join("\n"),
    enlaces:
      input.resolution.kind === "resolved" &&
      input.resolution.project_id === input.checkpoint.project.id &&
      input.project_title !== null
        ? `- [[${input.project_title}]]`
        : "",
  };
}

function builtInTemplate(input: BuildWritePlansInput): string {
  return [
    `# ${input.date}`,
    "",
    input.config.managed_headings.tareas,
    "",
    input.config.managed_headings.reflexion,
    "",
    input.config.managed_headings.notas,
    "",
    input.config.managed_headings.enlaces,
    "",
  ].join("\n");
}

function upsert(
  source: string,
  heading: string,
  sessionId: string,
  target: string,
  body: string,
): { ok: true; source: string } | { ok: false } {
  const replaced = replaceManagedBlock(source, sessionId, target, body);
  if (replaced.kind === "replaced") return { ok: true, source: replaced.source };
  if (replaced.kind !== "not_found") return { ok: false };
  const inserted = insertManagedBlock(source, heading, sessionId, target, body);
  return inserted.kind === "inserted"
    ? { ok: true, source: inserted.source }
    : { ok: false };
}

function plan(
  path: string,
  before: string | null,
  after: string,
  reason: WritePlanReason,
): WritePlan {
  return {
    path: parseWithSchema(VaultPathSchema, path, "write plan path"),
    before_hash: before === null ? null : hash(before),
    after_content: after,
    after_hash: hash(after),
    reason,
  };
}

/** Build in-memory plans only; this function performs no filesystem I/O. */
export function buildWritePlans(input: BuildWritePlansInput): RenderPlanResult {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.date);
  const dateIsValid = dateMatch !== null && (() => {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  })();
  if (!dateIsValid) {
    return { kind: "deferred", reason: "conflict", conflict_paths: [] };
  }
  const knowledgeCharacters = Object.values(input.checkpoint.knowledge)
    .flat()
    .reduce((total, item) => total + item.text.length, 0);
  const evidenceCharacters = Object.values(input.checkpoint.evidence)
    .flat()
    .reduce((total, item) => total + item.value.length, 0);
  if (
    knowledgeCharacters + evidenceCharacters > MAX_RENDER_SOURCE_CHARS ||
    (
      input.project_title !== null &&
      (input.project_title.length > 1_024 || !safeLinkTitle(input.project_title))
    )
  ) return { kind: "deferred", reason: "conflict", conflict_paths: [] };
  const sourceValues = [
    input.snapshots.daily,
    input.snapshots.project,
    input.snapshots.moc,
    input.snapshots.claude,
    input.template_source,
  ];
  if (sourceValues.some((source) => source !== null && source.length > MAX_RENDER_SOURCE_CHARS)) {
    return { kind: "deferred", reason: "conflict", conflict_paths: [] };
  }
  const plans: WritePlan[] = [];
  if (input.effective_targets.daily) {
    const before = input.snapshots.daily;
    let next = before ?? (input.template_source ?? builtInTemplate(input)).replaceAll("{{date}}", input.date);
    if (before === null) {
      const templateHeadings = DAILY_FRAGMENTS.map(
        (fragment) => findHeading(next, input.config.managed_headings[fragment.key]),
      );
      if (templateHeadings.some((heading) => heading.kind !== "found")) {
        const conflictPath = parseWithSchema(
          VaultPathSchema,
          `${input.config.daily_dir}/${input.date}.md`,
          "daily path",
        );
        return { kind: "deferred", reason: "conflict", conflict_paths: [conflictPath] };
      }
    }
    const bodies = dailyBodies(input);
    for (const fragment of DAILY_FRAGMENTS) {
      const body = bodies[fragment.key];
      const updated = upsert(
        next,
        input.config.managed_headings[fragment.key],
        input.checkpoint.source.session_id,
        fragment.target,
        body,
      );
      if (!updated.ok) {
        const conflictPath = parseWithSchema(
          VaultPathSchema,
          `${input.config.daily_dir}/${input.date}.md`,
          "daily path",
        );
        return { kind: "deferred", reason: "conflict", conflict_paths: [conflictPath] };
      }
      next = updated.source;
    }
    if (next !== before) {
      plans.push(plan(
        `${input.config.daily_dir}/${input.date}.md`,
        before,
        next,
        before === null ? "daily_create" : "daily_update",
      ));
    }
  }
  if (input.effective_targets.project) {
    if (
      input.resolution.kind !== "resolved" ||
      input.resolution.project_id !== input.checkpoint.project.id ||
      input.resolution.note_path === null ||
      input.snapshots.project === null
    ) {
      return { kind: "deferred", reason: "conflict", conflict_paths: [] };
    }
    const evidence = evidenceMap(input.checkpoint);
    const sections = [
      {
        heading: "### Estado",
        lines: linesFor(input.checkpoint.knowledge.status_changes, evidence, "- "),
      },
      {
        heading: "### Decisiones",
        lines: linesFor(input.checkpoint.knowledge.decisions, evidence, "- "),
      },
      {
        heading: "### Bloqueos",
        lines: linesFor(input.checkpoint.knowledge.blockers, evidence, "- "),
      },
      {
        heading: "### Siguientes pasos",
        lines: linesFor(input.checkpoint.knowledge.next_steps, evidence, "- "),
      },
    ];
    const body = sections
      .filter((section) => section.lines.length > 0)
      .map((section) => `${section.heading}\n${section.lines.join("\n")}`)
      .join("\n\n");
    if (body.length > 0) {
      const source = input.snapshots.project;
      const projectHeadings = ["## Estado actual", "## Estado"] as const;
      const foundHeadings = projectHeadings.filter(
        (heading) => findHeading(source, heading).kind === "found",
      );
      const invalidHeading = projectHeadings.some((heading) => {
        const found = findHeading(source, heading);
        return found.kind === "ambiguous" || found.kind === "invalid_heading";
      });
      if (invalidHeading || foundHeadings.length !== 1) {
        return {
          kind: "deferred",
          reason: "conflict",
          conflict_paths: [input.resolution.note_path],
        };
      }
      const sessionId = input.checkpoint.source.session_id;
      const replaced = replaceManagedBlock(source, sessionId, "project", body);
      let after: string | null = null;
      if (replaced.kind === "replaced") after = replaced.source;
      else if (replaced.kind === "not_found") {
        for (const heading of foundHeadings) {
          const inserted = insertManagedBlock(source, heading, sessionId, "project", body);
          if (inserted.kind === "inserted") {
            after = inserted.source;
            break;
          }
          if (inserted.kind !== "heading_missing") {
            return {
              kind: "deferred",
              reason: "conflict",
              conflict_paths: [input.resolution.note_path],
            };
          }
        }
      } else {
        return {
          kind: "deferred",
          reason: "conflict",
          conflict_paths: [input.resolution.note_path],
        };
      }
      if (after === null) {
        return {
          kind: "deferred",
          reason: "conflict",
          conflict_paths: [input.resolution.note_path],
        };
      }
      if (after !== source) {
        plans.push(plan(input.resolution.note_path, source, after, "project_update"));
      }
    }
  }
  if (input.effective_targets.landscape) {
    if (
      input.resolution.kind !== "resolved" ||
      input.resolution.project_id !== input.checkpoint.project.id ||
      input.project_title === null ||
      input.snapshots.moc === null ||
      input.snapshots.claude === null
    ) {
      return { kind: "deferred", reason: "landscape_ambiguous", conflict_paths: [] };
    }
    const latestStatus = input.checkpoint.knowledge.status_changes.at(-1)?.text;
    const latestNext = input.checkpoint.knowledge.next_steps.at(-1)?.text;
    if (latestStatus === undefined && latestNext === undefined) {
      return { kind: "deferred", reason: "landscape_ambiguous", conflict_paths: [] };
    }
    const parts = [`- [[${input.project_title}]]`];
    if (latestStatus !== undefined) parts.push(`estado: ${safeText(latestStatus)}`);
    if (latestNext !== undefined) parts.push(`siguiente: ${safeText(latestNext)}`);
    const body = parts.join(" — ");
    const landscapeTargets = [
      {
        path: "MOC — Inicio.md",
        heading: "## Proyectos",
        source: input.snapshots.moc,
        reason: "landscape_moc" as const,
      },
      {
        path: "CLAUDE.md",
        heading: "## Contexto activo",
        source: input.snapshots.claude,
        reason: "landscape_claude" as const,
      },
    ];
    for (const target of landscapeTargets) {
      const targetPath = parseWithSchema(VaultPathSchema, target.path, "landscape path");
      if (findHeading(target.source, target.heading).kind !== "found") {
        return {
          kind: "deferred",
          reason: "landscape_ambiguous",
          conflict_paths: [targetPath],
        };
      }
      const updated = upsert(
        target.source,
        target.heading,
        input.checkpoint.source.session_id,
        "landscape",
        body,
      );
      if (!updated.ok) {
        return {
          kind: "deferred",
          reason: "landscape_ambiguous",
          conflict_paths: [targetPath],
        };
      }
      if (updated.source !== target.source) {
        plans.push(plan(target.path, target.source, updated.source, target.reason));
      }
    }
  }
  return plans.length === 0 ? { kind: "nothing" } : { kind: "plan", plans };
}
