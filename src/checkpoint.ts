/** Canonical structured checkpoint normalization and idempotency. */
import { createHash } from "node:crypto";
import { IdempotencyKeySchema, parseCheckpoint, parseWithSchema } from "./schemas.js";
import type {
  ApplyCheckpoint,
  CheckpointRequest,
  IdempotencyKey,
  NoopReason,
  ProjectResolution,
  Targets,
} from "./types.js";

type Downgrade =
  | { from: "project"; reason: "ambiguous_project" }
  | { from: "landscape"; reason: "landscape_no_change" | "ambiguous_project" };

export type NormalizedCheckpoint =
  | {
      kind: "apply";
      checkpoint: ApplyCheckpoint;
      idempotency_key: IdempotencyKey;
      effective_targets: Targets;
      downgrade: Downgrade | null;
    }
  | {
      kind: "noop";
      checkpoint: Extract<CheckpointRequest, { kind: "noop" }>;
      idempotency_key: IdempotencyKey;
      reason: NoopReason;
    }
  | {
      kind: "invalid";
      reason:
        | "schema_rejected"
        | "empty_apply"
        | "missing_evidence"
        | "uncited_deployment_evidence";
    };

const KNOWLEDGE_KEYS = [
  "completed_tasks",
  "decisions",
  "status_changes",
  "blockers",
  "reusable_learnings",
  "next_steps",
] as const;
const EVIDENCE_KEYS = ["commits", "tests", "files", "deployments", "observations"] as const;

function inputIsBounded(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      nodes += 1;
      if (nodes > 10_000 || current.depth > 64) return false;
      if (typeof current.value !== "object" || current.value === null) continue;
      if (seen.has(current.value)) return false;
      seen.add(current.value);
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>);
      if (children.length > 4_096) return false;
      for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function canonicalApply(checkpoint: ApplyCheckpoint): ApplyCheckpoint {
  const knowledge: ApplyCheckpoint["knowledge"] = {
    completed_tasks: [],
    decisions: [],
    status_changes: [],
    blockers: [],
    reusable_learnings: [],
    next_steps: [],
  };
  for (const key of KNOWLEDGE_KEYS) {
    const seen = new Set<string>();
    for (const item of checkpoint.knowledge[key]) {
      const normalized = {
        text: canonicalText(item.text),
        evidence: [...new Set(item.evidence)],
      };
      if (normalized.text.length === 0 || seen.has(normalized.text)) continue;
      seen.add(normalized.text);
      knowledge[key].push(normalized);
    }
  }
  const evidence: ApplyCheckpoint["evidence"] = {
    commits: [], tests: [], files: [], deployments: [], observations: [],
  };
  for (const key of EVIDENCE_KEYS) {
    for (const item of checkpoint.evidence[key]) {
      evidence[key].push({ id: item.id, value: canonicalText(item.value) });
    }
  }
  return { ...checkpoint, knowledge, evidence };
}

function meaningful(checkpoint: ApplyCheckpoint): boolean {
  return KNOWLEDGE_KEYS.some((key) => checkpoint.knowledge[key].length > 0);
}

function evidencePolicy(
  checkpoint: ApplyCheckpoint,
): "missing_evidence" | "uncited_deployment_evidence" | null {
  for (const item of [
    ...checkpoint.knowledge.completed_tasks,
    ...checkpoint.knowledge.status_changes,
  ]) {
    if (item.evidence.length === 0) return "missing_evidence";
  }
  const cited = new Set(
    KNOWLEDGE_KEYS.flatMap((key) =>
      checkpoint.knowledge[key].flatMap((item) => item.evidence),
    ),
  );
  if (checkpoint.evidence.deployments.some((item) => !cited.has(item.id))) {
    return "uncited_deployment_evidence";
  }
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function idempotencyKey(checkpoint: CheckpointRequest): IdempotencyKey {
  const preimage = checkpoint.kind === "noop"
    ? checkpoint
    : {
        version: checkpoint.version,
        kind: checkpoint.kind,
        source: {
          agent: checkpoint.source.agent,
          host_id: checkpoint.source.host_id,
          session_id: checkpoint.source.session_id,
        },
        project: checkpoint.project,
        knowledge: checkpoint.knowledge,
        evidence: checkpoint.evidence,
        targets: checkpoint.targets,
      };
  const digest = createHash("sha256").update(stableJson(preimage), "utf8").digest("hex");
  return parseWithSchema(IdempotencyKeySchema, digest, "idempotency key");
}

/** Parse, canonicalize, policy-check, and fingerprint one checkpoint request. */
export function normalizeCheckpoint(
  value: unknown,
  project: ProjectResolution,
): NormalizedCheckpoint {
  let parsed: CheckpointRequest;
  try {
    if (!inputIsBounded(value)) return { kind: "invalid", reason: "schema_rejected" };
    parsed = parseCheckpoint(value);
  } catch {
    return { kind: "invalid", reason: "schema_rejected" };
  }
  if (parsed.kind === "noop") {
    return {
      kind: "noop",
      checkpoint: parsed,
      idempotency_key: idempotencyKey(parsed),
      reason: parsed.reason,
    };
  }
  const checkpoint = canonicalApply(parsed);
  if (!meaningful(checkpoint)) return { kind: "invalid", reason: "empty_apply" };
  if (EVIDENCE_KEYS.some((key) => checkpoint.evidence[key].some((item) => item.value.length === 0))) {
    return { kind: "invalid", reason: "schema_rejected" };
  }
  const evidenceFailure = evidencePolicy(checkpoint);
  if (evidenceFailure !== null) return { kind: "invalid", reason: evidenceFailure };

  const effectiveTargets: Targets = { ...checkpoint.targets };
  let downgrade: Downgrade | null = null;
  const projectMatches =
    project.kind === "resolved" &&
    project.note_path !== null &&
    project.project_id === checkpoint.project.id;
  if (effectiveTargets.project && !projectMatches) {
    effectiveTargets.daily = true;
    effectiveTargets.project = false;
    downgrade = { from: "project", reason: "ambiguous_project" };
  }
  const landscapeChanged =
    checkpoint.knowledge.status_changes.length > 0 ||
    checkpoint.knowledge.next_steps.length > 0;
  if (effectiveTargets.landscape && (!projectMatches || !landscapeChanged)) {
    if (!projectMatches) effectiveTargets.daily = true;
    effectiveTargets.landscape = false;
    if (downgrade === null) {
      downgrade = {
        from: "landscape",
        reason: projectMatches ? "landscape_no_change" : "ambiguous_project",
      };
    }
  }
  return {
    kind: "apply",
    checkpoint,
    idempotency_key: idempotencyKey(checkpoint),
    effective_targets: effectiveTargets,
    downgrade,
  };
}

export const evaluateCheckpoint = normalizeCheckpoint;
