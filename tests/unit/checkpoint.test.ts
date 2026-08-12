import { describe, expect, it } from "vitest";
import { normalizeCheckpoint } from "../../src/checkpoint.js";
import { parseProjectResolution } from "../../src/schemas.js";

function applyPayload(): Record<string, unknown> {
  return {
    version: 1,
    kind: "apply",
    source: {
      agent: "prime-agent",
      host_id: "workstation",
      session_id: "sess-01ab",
      cwd: "/workspace/atlas",
    },
    project: { id: "atlas" },
    knowledge: {
      completed_tasks: [{ text: "  Parsed   the manifest  ", evidence: ["c1"] }],
      decisions: [{ text: "Keep the parser strict", evidence: [] }],
      status_changes: [],
      blockers: [],
      reusable_learnings: [],
      next_steps: [],
    },
    evidence: {
      commits: [{ id: "c1", value: " a1b2c3d4 " }],
      tests: [],
      files: [],
      deployments: [],
      observations: [],
    },
    targets: { daily: true, project: true, landscape: false },
  };
}

describe("normalizeCheckpoint", () => {
  it("canonicalizes a meaningful apply and derives a stable idempotency key", () => {
    const resolution = parseProjectResolution({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Atlas.md",
    });
    const first = normalizeCheckpoint(applyPayload(), resolution);
    const duplicate = applyPayload();
    const knowledge = duplicate.knowledge as Record<string, unknown>;
    knowledge.completed_tasks = [
      { text: "Parsed the manifest", evidence: ["c1"] },
      { text: " Parsed the manifest ", evidence: [] },
    ];
    const second = normalizeCheckpoint(duplicate, resolution);

    expect(first.kind).toBe("apply");
    expect(second.kind).toBe("apply");
    if (first.kind === "apply" && second.kind === "apply") {
      expect(first.checkpoint.knowledge.completed_tasks).toEqual([
        { text: "Parsed the manifest", evidence: ["c1"] },
      ]);
      expect(first.checkpoint.evidence.commits).toEqual([
        { id: "c1", value: "a1b2c3d4" },
      ]);
      expect(first.idempotency_key).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.idempotency_key).toBe(first.idempotency_key);
    }
  });

  it("rejects empty applies and completed/status claims without evidence", () => {
    const empty = applyPayload();
    empty.knowledge = {
      completed_tasks: [], decisions: [], status_changes: [], blockers: [],
      reusable_learnings: [], next_steps: [],
    };
    expect(normalizeCheckpoint(empty, parseProjectResolution({ kind: "unresolved", reason: "no_match" })))
      .toEqual({ kind: "invalid", reason: "empty_apply" });

    const unverified = applyPayload();
    const knowledge = unverified.knowledge as Record<string, unknown>;
    knowledge.completed_tasks = [{ text: "Claimed complete", evidence: [] }];
    expect(normalizeCheckpoint(unverified, parseProjectResolution({ kind: "unresolved", reason: "no_match" })))
      .toEqual({ kind: "invalid", reason: "missing_evidence" });
  });

  it("passes through explicit no-ops and rejects dangling evidence citations", () => {
    const noop = normalizeCheckpoint(
      { version: 1, kind: "noop", reason: "lookup_only" },
      parseProjectResolution({ kind: "unresolved", reason: "no_match" }),
    );
    expect(noop.kind).toBe("noop");
    if (noop.kind === "noop") expect(noop.checkpoint.reason).toBe("lookup_only");

    const dangling = applyPayload();
    const knowledge = dangling.knowledge as Record<string, unknown>;
    knowledge.decisions = [{ text: "Unknown citation", evidence: ["missing"] }];
    expect(normalizeCheckpoint(dangling, parseProjectResolution({ kind: "unresolved", reason: "no_match" })))
      .toEqual({ kind: "invalid", reason: "schema_rejected" });
  });

  it("excludes cwd from idempotency and downgrades ambiguous project writes to daily only", () => {
    const firstPayload = applyPayload();
    firstPayload.targets = { daily: false, project: true, landscape: false };
    const secondPayload = applyPayload();
    secondPayload.targets = { daily: false, project: true, landscape: false };
    const secondSource = secondPayload.source as Record<string, unknown>;
    secondSource.cwd = "/different/local/path";
    const resolution = parseProjectResolution({
      kind: "ambiguous",
      candidates: ["Proyectos/Atlas.md", "Proyectos/Atlas 2.md"],
    });

    const first = normalizeCheckpoint(firstPayload, resolution);
    const second = normalizeCheckpoint(secondPayload, resolution);
    expect(first.kind).toBe("apply");
    expect(second.kind).toBe("apply");
    if (first.kind === "apply" && second.kind === "apply") {
      expect(first.idempotency_key).toBe(second.idempotency_key);
      expect(first.effective_targets).toEqual({ daily: true, project: false, landscape: false });
      expect(first.downgrade).toEqual({ from: "project", reason: "ambiguous_project" });
    }
  });

  it("rejects uncited deployment evidence", () => {
    const payload = applyPayload();
    const evidence = payload.evidence as Record<string, unknown>;
    evidence.deployments = [{ id: "d1", value: "production healthy" }];

    expect(normalizeCheckpoint(payload, parseProjectResolution({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Atlas.md",
    }))).toEqual({ kind: "invalid", reason: "uncited_deployment_evidence" });
  });

  it("downgrades project writes when the resolved project id does not match", () => {
    const result = normalizeCheckpoint(applyPayload(), parseProjectResolution({
      kind: "resolved",
      project_id: "different-project",
      basis: "portable_id",
      note_path: "Proyectos/Other.md",
    }));
    expect(result.kind).toBe("apply");
    if (result.kind === "apply") {
      expect(result.effective_targets.project).toBe(false);
      expect(result.downgrade).toEqual({ from: "project", reason: "ambiguous_project" });
    }
  });

  it("downgrades a resolved project with no note path and labels landscape ambiguity", () => {
    const payload = applyPayload();
    payload.targets = { daily: false, project: false, landscape: true };
    const result = normalizeCheckpoint(payload, parseProjectResolution({
      kind: "resolved",
      project_id: "prime-agent",
      basis: "portable_id",
      note_path: null,
    }));
    expect(result.kind).toBe("apply");
    if (result.kind === "apply") {
      expect(result.effective_targets).toEqual({ daily: true, project: false, landscape: false });
      expect(result.downgrade).toEqual({ from: "landscape", reason: "ambiguous_project" });
    }
  });

  it("drops landscape writes without a verified landscape change", () => {
    const payload = applyPayload();
    payload.targets = { daily: true, project: false, landscape: true };
    const result = normalizeCheckpoint(payload, parseProjectResolution({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Atlas.md",
    }));
    expect(result.kind).toBe("apply");
    if (result.kind === "apply") {
      expect(result.effective_targets.landscape).toBe(false);
      expect(result.downgrade).toEqual({ from: "landscape", reason: "landscape_no_change" });
    }
  });
});
